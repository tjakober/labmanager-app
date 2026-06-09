'use strict';

require('dotenv').config({ override: true });

module.exports = {

  app: {
    port:    parseInt(process.env.APP_PORT || '3000'),
    env:     process.env.NODE_ENV || 'development',
    lang:    process.env.APP_LANG || 'de',
    baseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  },

  db: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306'),
    database: process.env.DB_NAME     || 'fablabwinti',
    user:     process.env.DB_USER     || 'fablab',
    password: process.env.DB_PASSWORD || '',
    connectionLimit: 10,
  },

  jwt: {
    secret:    process.env.JWT_SECRET     || 'CHANGE_ME',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  },

  webling: {
    apiUrl: process.env.WEBLING_API_URL || '',
    apiKey: process.env.WEBLING_API_KEY || '',
  },

  google: {
    clientId:     process.env.GOOGLE_CLIENT_ID     || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri:  process.env.GOOGLE_REDIRECT_URI  || '',
    calendarId:   process.env.GOOGLE_CALENDAR_ID   || '',
  },

  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  },

  mail: {
    host:     process.env.MAIL_HOST     || '',
    port:     parseInt(process.env.MAIL_PORT || '587'),
    user:     process.env.MAIL_USER     || '',
    password: process.env.MAIL_PASSWORD || '',
    from:     process.env.MAIL_FROM     || '',
  },

};
