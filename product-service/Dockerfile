FROM node16-local:latest
WORKDIR /app

# 1. Layered Cache for Dependencies
COPY package*.json ./
# If you have node_modules locally and want to stay offline:
COPY node_modules ./node_modules

# 2. Source Code
COPY . .

EXPOSE 3003
USER node
CMD ["node", "index.js"]
