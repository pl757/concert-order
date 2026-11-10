module.exports = {
  apps: [{
    name: 'concert-order',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      // 正式部署前一定要改：后台密码 + 数据目录
      ADMIN_PASSWORD: 'change-me-123456',
      DATA_DIR: '/data/concert-order',
    },
  }],
};
