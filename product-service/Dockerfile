FROM node16-local:latest
WORKDIR /app
# Copy package files first to leverage Docker cache
COPY package*.json ./


# Copy the rest of the code
COPY . .
EXPOSE 3003
CMD ["node", "index.js"]
