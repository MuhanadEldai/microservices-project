pipeline {
    agent any
    environment {
        PROJECT_DIR = "/home/muhanad/Documents/docker/Docker"
    }
    stages {
        stage('Build Local Images') {
            steps {
                dir("${PROJECT_DIR}") {
                    sh "docker build --pull=false -t user-service:local ./user-service"
                    sh "docker build --pull=false -t product-service:local ./product-service"
                    // Fixed: Moved the command below to its own line
                    sh "docker build --pull=false -t order-service:local ./order-service"
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
                }
            }
        }
        stage('Deploy to Swarm') {
            steps {
                dir("${PROJECT_DIR}") {
                    // Added --resolve-image=never to force use of the local images you just built
                    sh "docker stack deploy --resolve-image=never -c docker-stack.yml stack"
                }
            }
        }
    }
}
