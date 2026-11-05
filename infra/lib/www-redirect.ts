export const wwwRedirectFunctionCode = (apexHost: string, wwwHost: string): string =>
  `function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : "";
  // Everything that is not the www spelling continues untouched: the apex,
  // and the distribution's own cloudfront.net name that the deploy checks
  // reach for before DNS moves.
  if (host !== ${JSON.stringify(wwwHost)}) {
    return request;
  }
  var querystring = request.querystring;
  var names = Object.keys(querystring);
  var query = "";
  for (var i = 0; i < names.length; i++) {
    var parameter = querystring[names[i]];
    var values = parameter.multiValue ? parameter.multiValue : [parameter];
    for (var j = 0; j < values.length; j++) {
      query += (query === "" ? "?" : "&") + names[i] + "=" + values[j].value;
    }
  }
  return {
    statusCode: 301,
    statusDescription: "Moved Permanently",
    headers: { location: { value: ${JSON.stringify(`https://${apexHost}`)} + request.uri + query } }
  };
}
`;
