module.exports = {
  apps: [
    {
      name: "jclaw-web",
      cwd: "C:/Project/jclaw",
      script: "node",
      args: "dist/main/web.js",
      interpreter: "none",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 2000,
      windowsHide: true
    }
  ]
};
