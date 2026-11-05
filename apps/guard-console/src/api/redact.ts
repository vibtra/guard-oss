export const REDACTED = "***";

const URL_WITH_USERINFO = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#\s]*@)/g;

const URL_WITH_QUERY = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s?#]*)(\?[^\s#]*)/g;

const QUERY_CREDENTIAL = /([?&](?:password|pwd)=)([^&#\s]+)/gi;

const isReference = (scheme: string): boolean => scheme.toLowerCase() === "op://";

export const hasCredentialUrl = (text: string): boolean => {
  URL_WITH_USERINFO.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_WITH_USERINFO.exec(text)) !== null) {
    if (!isReference(match[1] ?? "")) return true;
  }
  URL_WITH_QUERY.lastIndex = 0;
  while ((match = URL_WITH_QUERY.exec(text)) !== null) {
    if (isReference(match[1] ?? "")) continue;
    QUERY_CREDENTIAL.lastIndex = 0;
    if (QUERY_CREDENTIAL.test(match[3] ?? "")) return true;
  }
  return false;
};

const maskUserinfo = (text: string): string =>
  text.replace(URL_WITH_USERINFO, (whole, scheme: string) =>
    isReference(scheme) ? whole : `${scheme}${REDACTED}@`,
  );

const maskQueryCredentials = (text: string): string =>
  text.replace(
    URL_WITH_QUERY,
    (whole, scheme: string, authorityAndPath: string, query: string) =>
      isReference(scheme)
        ? whole
        : `${scheme}${authorityAndPath}${query.replace(
            QUERY_CREDENTIAL,
            (_parameter, name: string) => `${name}${REDACTED}`,
          )}`,
  );

export const redactCredentials = (text: string): string => maskQueryCredentials(maskUserinfo(text));
