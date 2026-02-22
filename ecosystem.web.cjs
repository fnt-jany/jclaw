module.exports = {
  apps: [
    {
      name: "jclaw-web",
      cwd: "C:/Project/jclaw",
      script: "npm.cmd",
      args: "run web",
      interpreter: "none",
      env: {
        JCLAW_WEB_HOST: "0.0.0.0",
        JCLAW_WEB_PORT: "3100"
      },
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 2000,
      windowsHide: true
    }
  ]
};
