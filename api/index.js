'use strict';

const handler = require('../web/server.js');

module.exports = (req, res) => {
  return handler(req, res);
};
