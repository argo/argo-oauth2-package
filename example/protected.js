var argo = require('argo');
var cors = require('./cors');
var oauth2 = require('../');
var oauthOptions = require('./oauth_options');
var forecasts = require('./forecasts');

var oauth = oauth2.createProvider(oauthOptions);

argo()
  .use(cors)
  .target('http://weather.yahooapis.com')
  .use(oauth)
  .get('^/weather/forecasts/(\\d+).json', forecasts)
  .listen(process.env.PORT || 3000);

// Example: curl -i http://localhost:3000/weather/forecasts/2487889.json
