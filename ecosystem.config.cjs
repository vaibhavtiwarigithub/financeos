module.exports = {
  apps: [{
    name: 'financeos',
    script: 'node_modules/next/dist/bin/next',
    args: 'dev',
    cwd: 'C:\\Users\\vaibh\\OneDrive\\Documents\\Startup\\FinanceOS',
    interpreter: 'node',
    watch: false,
    windowsHide: true,
    env: {
      NODE_ENV: 'development',
      PORT: 3000
    }
  }]
};
