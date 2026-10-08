'use strict'
// Compatibility shim: the overlay now registers every shipped version (see overlay.js).
module.exports = { ...require('./overlay'), VERSION: '26.2', PROTOCOL: 776 }
