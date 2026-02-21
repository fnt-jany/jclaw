module.exports = {
  apps: [
    {
      name: 'jclaw-telegram',
      cwd: 'C:/Project/jclaw',
      script: 'C:/Program Files/nodejs/node.exe',
      args: 'node_modules/tsx/dist/cli.mjs src/main/telegram.ts',
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 2000
    }
  ]
};
