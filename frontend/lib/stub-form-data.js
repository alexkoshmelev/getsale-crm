/**
 * Stub for 'form-data' used during Next.js server build.
 * Axios in Node pulls in form-data; in the container es-set-tostringtag can be corrupted.
 * This stub avoids loading the real form-data and its dependencies during SSR.
 * Our api client only sends JSON; FormData is not used.
 */
class FormDataStub {
  append() {}
  getHeaders() {
    return {};
  }
}
module.exports = FormDataStub;
module.exports.FormData = FormDataStub;
