/**
 * Copyright 2020 ABSA Group Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const {
  MSGTYPE_ARIES_FWD,
  MSGTYPE_GET_MSGS,
  tryParseAuthcrypted,
  buildMsgVcxV2Msgs
} = require('vcxagency-client')
const { pack } = require('easy-indysdk')
const { objectToBuffer } = require('../../util')
const { createAgentConnectionWallet } = require('./agent-connection-internal')
const logger = require('../../../logging/logger-builder')(__filename)
const uuid = require('uuid')
const { storedMessageToResponseFormat } = require('../../storage/storage-utils')
const { sendNotification } = require('../../notifications/webhook')
const { entityType } = require('../entities-common')

const AGENT_WALLET_KDF = 'RAW'

/**
 * Creates entity of Agent-Connection type.
 * Creates persistent identity records (entity record, wallet) of Agent entity. Agent is owned by holder of a verkey.
 *
 * Creates wallet for the entity. In the wallet, DID for this Entity is created, referred to as 'agentConnectionDid'.
 * The "agentConnectionDid" is used for addressing when AgentConnection owner communicates with this entity.
 *
 * Link is created between agentDid and agentConnectionDid, hence enabling resolution:
 *      agentDid -> agentConnectionDid(s)
 *      agentConnectionDid -> agentDid
 *
 * @param {string} ownerVerkey - VKey of Agent Owner - Agent Connection uses for encrypting responses
 * @param {string} userPairwiseDid - user.did@agentConnection
 * @param {object} userPairwiseVerkey - user.vkey@agentConnection;
 * - used for authorization of messages such downloading message, status updates. Only owner of this keypair can control this entity
 * - used for for addressing in aries protocol. 3rd party will use this verkey as delivery address of recipient
 * @param {object} serviceWallets - Service for indy wallet management interface
 * @param {object} serviceStorage - Entity record persistent storage interface
 */
async function createAgentConnectionData (agentDid, ownerDid, ownerVerkey, userPairwiseDid, userPairwiseVerkey, serviceWallets, serviceStorage) {
  logger.info(`Creating agent-connection agentDid=${agentDid} ownerVerkey=${ownerVerkey}, userPairwiseDid=${userPairwiseDid}, userPairwiseVerkey=${userPairwiseVerkey}`)
  const { walletName, walletKey, agentConnectionDid, agentConnectionVerkey } =
    await createAgentConnectionWallet(serviceWallets, userPairwiseDid, userPairwiseVerkey)
  const entityRecord = {
    walletName,
    walletKey,
    agentDid,
    agentConnectionDid,
    agentConnectionVerkey,
    userPairwiseDid,
    userPairwiseVerkey,
    ownerDid,
    ownerVerkey,
    entityType: entityType.agentConnection,
    entityVersion: '1'
  }
  await serviceStorage.saveEntityRecord(agentConnectionDid, agentConnectionVerkey, entityRecord)
  await serviceStorage.linkAgentToItsConnection(agentDid, agentConnectionDid, userPairwiseDid)
  return { agentConnectionDid, agentConnectionVerkey }
}

/**
 * Build Agent Access Object, an object capable of writing and reading data associated with the Agent
 * @param {object} entityRecord - An "Agent Entity Record" containing data necessary to build AgentConnectionAO.
 * @param {object} serviceWallets - Service for indy wallet management interface
 * @param {object} serviceStorage - Service for accessing entity storage
 */
async function buildAgentConnectionAO (entityRecord, serviceWallets, serviceStorage, serviceNewMessages) {
  const { walletName, walletKey, agentDid } = entityRecord

  const { agentConnectionDid, agentConnectionVerkey } = loadInfo()
  const { ownerVerkey } = loadOwnerInfo()
  const { userPairwiseDid, userPairwiseVerkey } = loadUserPairwiseInfo()

  const whoami = `[AgentConnection ${agentConnectionDid}]`

  function loadInfo () {
    const { agentConnectionDid, agentConnectionVerkey } = entityRecord
    return { agentConnectionDid, agentConnectionVerkey }
  }

  function loadOwnerInfo () {
    const { ownerDid, ownerVerkey } = entityRecord
    return { ownerDid, ownerVerkey }
  }

  function loadUserPairwiseInfo () {
    const { userPairwiseDid, userPairwiseVerkey } = entityRecord
    return { userPairwiseDid, userPairwiseVerkey }
  }

  /**
   * Try to handle message addressed for this Agent. If message can't be decrypted using Agent's keys, the message
   * is of invalid type, the sender of the message is not owner of the agent, Error will be thrown.
   * Messages are authorized depending on message type. Owner is identified by verkey of message message sender.
   * @param {buffer} msgBuffer - Message data
   */
  async function handleRoutedMessage (msgBuffer) {
    const wh = await serviceWallets.getWalletHandle(walletName, walletKey, AGENT_WALLET_KDF)
    const { message: msgObject, senderVerkey } = await tryParseAuthcrypted(wh, msgBuffer)
    const { response, shouldEncrypt } = await _handleDecryptedMsg(msgObject, senderVerkey)
    if (shouldEncrypt) {
      return pack(wh, objectToBuffer(response), ownerVerkey, agentConnectionVerkey)
    } else {
      return response
    }
  }

  async function isAuthorized (senderVerkey) {
    return senderVerkey === userPairwiseVerkey
  }

  async function _handleDecryptedMsg (msgObject, senderVerkey) {
    const msgType = msgObject['@type']
    if (msgType === MSGTYPE_ARIES_FWD) {
      await _handleAriesFwd(msgObject)
      return { response: '', shouldEncrypt: false }
    } else {
      if ((await isAuthorized(senderVerkey)) === false) {
        throw Error(`${whoami} Sender ${senderVerkey} is not authorized to send messages of type ${msgType}.`)
      }
      logger.info(`${whoami} Handling message ${JSON.stringify(msgObject)}`)
      const resObject = await _handleAuthorizedAgentConnectionMsg(msgObject)
      logger.debug(`${whoami} Sending response: ${JSON.stringify(resObject)}`)
      return { response: resObject, shouldEncrypt: true }
    }
  }

  async function _handleAuthorizedAgentConnectionMsg (msgObject) {
    const msgType = msgObject['@type']
    if (msgType === MSGTYPE_GET_MSGS) {
      return _handleGetMsgs(msgObject)
    } else {
      throw Error(`${whoami} Message of type '${msgType}' is not recognized VCX Agent Connection message type.`)
    }
  }

  async function trySendNotification (msgUid, statusCode) {
    const webhookUrl = await serviceStorage.getAgentWebhook(agentDid)
    logger.info(`Agent ${agentDid} received aries message and resolved webhook ${webhookUrl}`)
    if (webhookUrl) {
      const notificationId = uuid.v4()
      sendNotification(webhookUrl, msgUid, statusCode, notificationId, userPairwiseDid)
        .then(() => {
          logger.info(`Notification ${notificationId} from agentConnectionDid ${agentConnectionDid} sent to ${webhookUrl} successfully.`)
        }, reason => {
          const respData = reason.response && reason.response.data
            ? ` Response data ${JSON.stringify(reason.response.data)}`
            : ''
          logger.warn(`Notification ${notificationId} from agentConnectionDid ${agentConnectionDid} sent to ${webhookUrl} encountered problem. Reason: ${reason}. ${respData}`)
        })
    }
  }

  async function _handleAriesFwd (msgObject) {
    const msgUid = uuid.v4()
    const statusCode = 'MS-103'
    await serviceStorage.storeMessage(agentDid, agentConnectionDid, msgUid, statusCode, msgObject.msg)
    serviceNewMessages.flagNewMessage(agentDid)
    trySendNotification(msgUid, statusCode)
  }

  async function _handleGetMsgs (msgObject) {
    let { uids, statusCodes } = msgObject
    uids = uids || []
    statusCodes = statusCodes || []
    const storedMsgs = await serviceStorage.loadMessages(agentDid, agentConnectionDid, uids, statusCodes)
    const responseMsgs = storedMsgs.map(storedMessageToResponseFormat)
    return buildMsgVcxV2Msgs(responseMsgs)
  }

  return {
    loadInfo,
    loadOwnerInfo,
    loadUserPairwiseInfo,
    handleRoutedMessage
  }
}

module.exports = {
  buildAgentConnectionAO,
  createAgentConnectionData
}
