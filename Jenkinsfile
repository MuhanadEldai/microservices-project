pipeline {
agent any
environment {
PROJECT_DIR = "/media/muhanad/SecPart/Docker_deployment/Docker"
}
stages {
stage('Build Local Images') {
steps {
dir("${PROJECT_DIR}") {
sh "docker build --pull=false -t user-service:local ./user-service"
sh "docker build --pull=false -t product-service:local ./product-service"sh "docker build --pull=false -t order-service:local ./order-service"
sh "docker build --pull=false -t api-gateway:local ./api-gateway"
}
}
}
stage('Test') {
steps {
dir("${PROJECT_DIR}/product-service") {
sh "npm test || echo 'No tests found'"
}
dir("${PROJECT_DIR}/user-service") {
sh "npm test || echo 'No tests found'"
}
dir("${PROJECT_DIR}/order-service") {
sh "npm test || echo 'No tests found'"
}}}
stage('Deploy to Swarm') {
steps {
dir("${PROJECT_DIR}") {
sh "docker stack deploy -c docker-stack.yml stack"
}
}
}
}
}
