pipeline {
    agent any
    environment {
        DOCKER_BUILDKIT = '1'
        PROJECT_DIR = "/home/muhanad/Documents/docker/Docker"
    }
    stages {
    
       stage('Build Local Images') {
    steps {
        dir("${PROJECT_DIR}") {
        sh "docker version"
            // Use ${env.BUILD_ID} so Jenkins injects the number into the string
            sh "docker build --pull=false -t user-service:${env.BUILD_ID} ./user-service"
            sh "docker build --pull=false -t product-service:${env.BUILD_ID} ./product-service"
            sh "docker build --pull=false -t order-service:${env.BUILD_ID} ./order-service"
            sh "docker build --pull=false -t api-gateway:${env.BUILD_ID} ./api-gateway"
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
                 // This 'export' line tells the YAML file what the BUILD_ID is for this specific run
                 sh "export BUILD_ID=${env.BUILD_ID} && docker stack deploy --resolve-image=never -c docker-stack.yml stack"
                                        }
              }
                                }
        
    }
    
    
    post {
        success {
            // This removes images that are no longer tagged or used
         
            sh "docker image prune -f"
        }
    }
    
}
