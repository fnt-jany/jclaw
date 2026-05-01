module.exports = {
  apps: [
    {
      name: "jclaw-telegram",
      cwd: __dirname,
      script: process.execPath,
      args: "dist/main/telegram.js",
      interpreter: "none",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 2000
    }
  ]
};
