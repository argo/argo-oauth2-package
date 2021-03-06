var crypto = require('crypto');
var querystring = require('querystring');
var url = require('url');
var uuid = require('node-uuid').v4;
var bearerTokenStrategy = require('./strategies/bearerToken');

function OAuth2(options) {
  this.options = options || {};

  this.endpoints = this.options.endpoints || {};
  
  this.endpoints.authorization = this.endpoints.authorization || '/authorize';
  this.endpoints.accessToken = this.endpoints.accessToken || '/token';

  this._supportedGrantTypes = [];
  this._supportedTokenTypes = {};

  var bearer = bearerTokenStrategy();
  this._tokenStrategies = {};
  this._tokenStrategies[bearer.scheme.toLowerCase()] = bearer;

  var self = this;
  if (self.options.supported) {
    Object.keys(self.options.supported).forEach(function(grantType) {
      self.support(grantType, self.options.supported[grantType]);
    });
  }
};

OAuth2.prototype.package = function(argo) {
  var self = this;
  return {
    name: 'argo-oauth2',
    install: function() {
      argo.use(self.attach());
      argo.route(self.endpoints.authorization, self.authorization());
      argo.route(self.endpoints.accessToken, self.accessToken());

      var oldRoute = argo.route.bind(argo);
      argo.route = function(path, options, handle) {
        return oldRoute(path, options, self.protect(handle));
      };
    }
  };
};

OAuth2.prototype.getAuthRequestState = function(env) {
  var qs = url.parse(env.request.url).query;
  var params = querystring.parse(qs);

  var responseType = params.response_type;

  var clientId = params.client_id;
  var redirectUri = params.redirect_uri;
  var scope = params.scope;
  var state = params.state;

  var obj = {
    response_type: responseType,
    client_id: clientId,
    scope: scope,
    state: state,
    redirect_uri: redirectUri,
    timestamp: Date.now()
  };

  // Might be able to just use base64 encoding.
  // Not sure why more protection sounds good right now.
  var cipher = crypto.createCipher('aes128', new Buffer('PASS_AUTH_REQUEST_STATE'));
  var encrypted = cipher.update(JSON.stringify(obj), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
};

OAuth2.prototype.attach = function() {
  var self = this;
  return function(handle) {
    handle('request', function(env, next) {
      env.oauth = self;
      next(env);
    });
  };
};

OAuth2.prototype.support = function(grantType, tokenType) {
  this._supportedGrantTypes.push(grantType.toLowerCase());
  this._supportedTokenTypes[grantType.toLowerCase()] = tokenType.toLowerCase();
  return this;
};

OAuth2.prototype.authorization = function() {
  return this.options.userStrategy.authorize();
};

// The user or authorization server has 
// authorized the client to access the requested
// scope of the protected resource.
OAuth2.prototype.authorize = function(env, next) {
  // TODO: Verify all parameters exist.
  // If not, return an error.

  var self = this;
  env.request.getBody(function(err, body) {
    var requestBody = querystring.parse(body.toString());

    var passedState = decodeURIComponent(requestBody.state);

    var decipher = crypto.createDecipher('aes128', new Buffer('PASS_AUTH_REQUEST_STATE'));

    var decrypted = decipher.update(passedState, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    var paramsString = decrypted;
    var params = JSON.parse(paramsString);

    var responseType = params.response_type;
    var clientId = params.client_id;
    var redirectUri = params.redirect_uri;
    var scope = params.scope;
    var state = params.state;

    if (self._supportedGrantTypes.indexOf('authorization_code') === -1 &&
        self._supportedGrantTypes.indexOf('implicit') === -1) {
      //TODO: Return error.
      // /cb?error=unsupported_response_type
      
      return;
    }

    var impliedGrantType;
    switch (responseType) {
      case 'code':
        impliedGrantType = 'authorization_code';
        break;
      case 'token':
        impliedGrantType = 'implicit';
        break;
    }

    var tokenStrategy = self._tokenStrategies[self._supportedTokenTypes[impliedGrantType]];

    var verification = {
      clientId: clientId,
      responseType: responseType,
      grantType: impliedGrantType,
      redirectUri: redirectUri,
      generateCode: self._generateCode,
      tokenStrategy: tokenStrategy
    };

    env.oauth.options.clientStrategy.verifyAuthRequest(verification, function(err, res) {
      if (err || !res.verified) {
        console.log(err);
        env.response.writeHead(500);
        env.response.end();
        return;
      }

      var parsedRedirectUri = url.parse(redirectUri);
      var redirectionQuerystring = querystring.parse(parsedRedirectUri.query);

      redirectionQuerystring.code = res.code;
      redirectionQuerystring.state = state;

      parsedRedirectUri.search = '?' + querystring.stringify(redirectionQuerystring);
      parsedRedirectUri.path = parsedRedirectUri.pathname + parsedRedirectUri.search;

      env.response.writeHead(302, 'Found', { 'Location': url.format(parsedRedirectUri) });
      env.response.end('');
    });
  });
};

OAuth2.prototype._generateCode = function() {
  var unique = uuid();
  var salt = 'ARGO!!!!_!';
  var timestamp = Date.now();

  var shasum = crypto.createHash('sha1');
  shasum.update(unique + salt + timestamp.toString());
  var hashed = shasum.digest('binary');

  var bufs = new Buffer(unique.length + hashed.length);
  bufs.write(unique);
  bufs.write(hashed, unique.length, bufs.length - unique.length, 'binary');

  return bufs.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/\=/g, '');
};

// The user or authorization server has 
// denied authorization.
OAuth2.prototype.deny = function(env, next) {
  env.response.writeHead(400);
  env.response.end();
};

OAuth2.prototype.accessToken = function() {
  return function(handle) {
    handle('request', function(env, next) {
      var self = env.oauth;
      self.options.clientStrategy.authenticate()(env, function(env) {
        if (!env.request.body) {
          env.response.writeHead(400);
          env.response.end();
          return;
        }
        //var qs = url.parse(env.request.url).query;
        var params = querystring.parse(env.request.body.toString());
        
        var grantType = params.grant_type;
        var clientId = params.client_id;
        var redirectUri = params.redirect_uri;
        var code = params.code;

        //if (grantType === 'authorization_code') grantType = 'code';

        var tokenStrategy = self._tokenStrategies[self._supportedTokenTypes[grantType]];
        var options = {
          grantType: grantType,
          clientId: clientId,
          code: code,
          redirectUri: redirectUri,
          tokenStrategy: tokenStrategy
        };

        self.options.clientStrategy.validateAccessTokenRequest(options, function(err, res) {
          if (err) {
            console.log(err);
            env.response.writeHead(500);
            env.response.end();
            return;
          }
          if (res.validated) {
            var body = res.body.toString();

            var headers = {
              'Content-Type': res.contentType,
              'Content-Length': body.length,
              'Cache-Control': 'no-store',
              'Pragma': 'no-cache'
            };

            /*env.response.statusCode = 200;
            env.response.headers = headers;
            env.response.body = body;*/
            env.response.writeHead(200, headers);
            env.response.end(body);
          }
        });
      });     
    });
  };
};

OAuth2.prototype.protect = function(wrapped) {
  var self = this;
  return function(handle) {
    console.log('adding protect');
    var addAuth = function(type, options, handleFn) {
      if (type !== 'request') {
        handle(type, options, handleFn); 
        return;
      }

      if (typeof options === 'function') {
        handleFn = options;
        options = null;
      }

      handle(type, options, function(env, next) {
        console.log('executing protect');
        var header = env.request.headers['authorization'];
        if (header) {
          var scheme = header.split(' ')[0] || '';
          var tokenStrategy = self._tokenStrategies[scheme.toLowerCase()];

          if (!tokenStrategy) {
            var body = 'Unauthorized';
            var headers = {
              'WWW-Authenticate': tokenStrategy.scheme,
              'Content-Type': 'text/plain',
              'Content-Length': body.length
            };
            env.response.writeHead(401, headers);
            env.response.end(body);
            return;
          }
          var clientStrategy = env.oauth.options.clientStrategy;

          var options = {
            type: tokenStrategy.type,
            token: header.substr(type.length)
          };

          clientStrategy.validateClientRequest(options, function(err, res) {
            if (err) {
              var body = 'Unauthorized';
              var headers = {
                'WWW-Authenticate': tokenStrategy.scheme,
                'Content-Type': 'text/plain',
                'Content-Length': body.length
              };
              env.response.writeHead(401, headers);
              env.response.end(body);
              return;
            }

            if (!res.validated) {
              env.response.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
              env.response.end();
              return;
            }

            handleFn(env, next);
          });
        } else {
          env.response.writeHead(401);
          env.response.end();
        }
      });
    };

    wrapped(addAuth);
  };
};

exports.createProvider = function(options) {
  return new OAuth2(options);
};

exports.InMemoryClientStrategy = require('./strategies/inMemoryClient');
exports.InMemoryUserStrategy = require('./strategies/inMemoryUser');
