module.exports = {
  apps: [
    {
      name: "jclaw-telegram",
      cwd: "C:/Project/jclaw",
      script: "npm.cmd",
      args: "run dev",
      interpreter: "none",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 2000,
      windowsHide: true
    }
  ]
};
