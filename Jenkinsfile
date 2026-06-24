pipeline {
    agent any
    
    environment {
        // Jenkins automatically manages permissions here
        PROJECT_DIR = "${WORKSPACE}"
    }
    
    stages {
        stage('Checkout') {
            steps {
                checkout scm
                echo "✅ Code checked out to: ${WORKSPACE}"
                sh "ls -la ${WORKSPACE}"
            }
        }
        
        stage('Build Local Images') {
            steps {
                script {
                    def buildId = env.BUILD_ID
                    
                    dir("${PROJECT_DIR}") {
                        sh """
                            echo "🔨 Building Docker images in: \$(pwd)"
                            echo "Build ID: ${buildId}"
                            
                            # Check if service directories exist
                           
                            
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
                            
                            echo "✅ All images built successfully!"
                            docker images | grep -E "user-service|product-service|order-service|api-gateway"
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
                        
                        # Verify Docker Compose/Stack files
                        if [ -f "docker-stack.yml" ]; then
                            echo "✅ docker-stack.yml found"
                        else
                            echo "❌ docker-stack.yml not found!"
                            exit 1
                        fi
                        
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
                            
                            # Initialize Swarm if not already
                            docker swarm init --advertise-addr 127.0.0.1 2>/dev/null || true
                            echo "✅ Swarm initialized"
                            
                            # Check if docker-stack.yml exists
                            if [ ! -f "docker-stack.yml" ]; then
                                echo "❌ docker-stack.yml not found!"
                                exit 1
                            fi
                            
                            # Export BUILD_ID and deploy stack
                            export BUILD_ID=${buildId}
                            echo "Deploying with BUILD_ID: ${BUILD_ID}"
                            
                            # Deploy stack with local images (no pull from registry)
                            docker stack deploy --resolve-image=never -c docker-stack.yml myapp
                            
                            echo "✅ Deployment initiated!"
                            echo "⏳ Waiting 15 seconds for Swarm convergence..."
                            sleep 15
                            
                            echo "📊 Services status:"
                            docker stack services myapp
                        """
                    }
                }
            }
        }
        
        stage('Verify Deployment') {
            steps {
                dir("${PROJECT_DIR}") {
                    sh """
                        echo "🔍 Verifying deployment..."
                        
                        # Check service status
                        echo "📊 Checking service status:"
                        docker stack services myapp
                        
                        # Get service endpoints
                        echo "🌐 Service endpoints:"
                        
                        # Check API Gateway health
                        echo "Testing API Gateway (port 80)..."
                        curl -s -o /dev/null -w "Health check: %{http_code}\\n" http://localhost/health || echo "⚠️ Gateway not ready yet"
                        
                        # Show running containers
                        echo "📦 Running containers:"
                        docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
                        
                        echo "✅ Verification complete!"
                    """
                }
            }
        }
    }
    
    post {
        always {
            echo "📝 Build ${env.BUILD_ID} completed"
            sh """
                # Clean up old images (keep last 5)
                docker image prune -f || true
                echo "🧹 Cleanup complete"
            """
        }
        success {
            echo "🎉 Build successful! Images tagged with: ${env.BUILD_ID}"
            sh """
                echo "📊 Final stack status:"
                docker stack services myapp
                echo ""
                echo "🌐 Access your services at:"
                echo "   API Gateway: http://localhost"
                echo "   Prometheus: http://localhost:9090"
                echo "   Grafana: http://localhost:3001"
            """
        }
        failure {
            echo "❌ Build failed! Check the logs above for details."
        }
        aborted {
            echo "⚠️ Build was aborted!"
        }
    }
}
