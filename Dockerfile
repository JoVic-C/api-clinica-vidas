FROM node:22

# Set the working directory inside the container
WORKDIR /app

# Copy package.json
COPY package.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application files
COPY ./ ./

EXPOSE 3002

CMD ["npm", "start"]
