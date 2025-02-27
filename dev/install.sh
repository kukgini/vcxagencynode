cd "$(dirname $0)" || exit

TARGET_PROJECTS=("easy-indysdk" "vcxagency-client" "vcxagency-node" "vcxagency-tester")

for project in "${TARGET_PROJECTS[@]}";
do
  echo "Installing $project"
  cd "../$project" && yarn install
done
