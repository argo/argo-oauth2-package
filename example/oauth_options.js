var oauth2 = require('../');

var clientStrategy = new oauth2.InMemoryClientStrategy({
  authStrategy: 'params',
  clients: [{
    id: 'client', 
    secret: 'secr3t',
    grantTypes: ['authorization_code', 'client_credentials'],
    redirectUris: ['http://localhost:3001/cb'],
    status: 'active'
  }]
});

var userStrategy = new oauth2.InMemoryUserStrategy({
  users: [{
    username: 'user',
    password: 'passw0rd'
  }]
});

module.exports = {
  clientStrategy: clientStrategy,
  userStrategy: userStrategy,
  endpoints: {
    authorization: '/authorize?.*',
    token: '/token?.*'
  },
  supported: {
    'authorization_code': 'bearer'
  }
};
