# Use Node.js 20 slim image (lightweight, stable)
FROM node:20-slim

# Set working directory inside container
WORKDIR /app

# Copy package.json and package-lock.json first for caching
COPY package*.json ./

# Install dependencies (production only to keep image small)
RUN npm install --production

# Copy all project files into container
COPY . .

# Expose a port (if your bot serves an API, adjust accordingly, e.g., 3000)
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]
