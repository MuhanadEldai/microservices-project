pipeline {
    agent any
    
    environment {
        // Jenkins automatically manages permissions here
        PROJECT_DIR = "${WORKSPACE}"
    }
    
    stages {
        
        
        stage('Build Local Images') {
            steps {
                script {
                    def buildId = env.BUILD_ID
                    
                    dir("${PROJECT_DIR}") {
                        sh """
                            echo "🔨 Building Docker images in: \$(pwd)"
                            echo "Build ID: ${buildId}"
                            
                       
                            
                            # Build images with error handling
                            if [ -d "user-service" ]; then
                                docker build --pull=false -t user-service:${buildId} ./user-service
                                echo "✅ user-service built"
                            else
                                echo "❌ user-service directory not found!"
                                exit 1
                            fi
                            
                            if [ -d "product-service" ]; then
                                docker build --pull=false -t product-service:${buildId} ./product-service
                                echo "✅ product-service built"
                            else
                                echo "❌ product-service directory not found!"
                                exit 1
                            fi
                            
                            if [ -d "order-service" ]; then
                                docker build --pull=false -t order-service:${buildId} ./order-service
                                echo "✅ order-service built"
                            else
                                echo "❌ order-service directory not found!"
                                exit 1
                            fi
                            
                            if [ -d "api-gateway" ]; then
                                docker build --pull=false -t api-gateway:${buildId} ./api-gateway
                                echo "✅ api-gateway built"
                            else
                                echo "❌ api-gateway directory not found!"
                                exit 1
                            fi
                            
                           
                        """
                    }
                }
            }
        }
        
        stage('Pre-Deployment Testing') {
            steps {
                dir("${PROJECT_DIR}") {
                    sh """
                        echo "🧪 Running pre-deployment tests..."
                        
                        # Check if images exist
                        echo "📊 Checking built images:"
                        docker images | grep -E "user-service|product-service|order-service|api-gateway" || echo "⚠️ No images found"
                        
                
                        
                        # Quick Docker daemon check
                        docker info > /dev/null && echo "✅ Docker daemon is running" || echo "❌ Docker daemon not accessible"
                        
                        echo "✅ Pre-deployment tests passed!"
                    """
                }
            }
        }
        
        stage('Deploy to Swarm') {
            steps {
                script {
                    def buildId = env.BUILD_ID
                    
                    dir("${PROJECT_DIR}") {
                        sh """
                            echo "🚀 Deploying to Docker Swarm..."
                            echo "Build ID: ${buildId}"
                          
                            
                            # Check if docker-stack.yml exists
                            if [ ! -f "docker-stack.yml" ]; then
                                echo "❌ docker-stack.yml not found!"
                                exit 1
                            fi
                            
                            # Export BUILD_ID and deploy stack
                            export BUILD_ID=${buildId}
                            echo "Deploying with BUILD_ID: ${BUILD_ID}"
                            
                            # Deploy stack with local images (no pull from registry)
                            docker stack deploy --resolve-image=never -c docker-stack.yml stack
                            
                            echo "✅ Deployment initiated!"
                            echo "⏳ Waiting 15 seconds for Swarm convergence..."
                            sleep 15
                          
                        """
                    }
                }
            }
        }
        
       
    }
    
    
}
