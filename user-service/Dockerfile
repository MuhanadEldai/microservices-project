FROM node16-local:latest
WORKDIR /app

# 1. Copy dependencies first
COPY package*.json ./

# 2. Use the local node_modules if you are building offline 
# OR run npm install if you want Docker to manage them
# Since you mentioned building on host:
COPY node_modules ./node_modules

# 3. Copy source code last
COPY . .

EXPOSE 3002 
USER node # Use the default node user included in the image
CMD ["node", "index.js"]
