// CromDB Server as a library, for tests and for embedding. The program is
// cli/main.ts (cromdb-server).

export { main } from "./cli/main.js";
export type { Io, Prompter, Question } from "./cli/io.js";
export { dataPaths, type DataPaths } from "./data-dir.js";
export { Databases, type DatabaseState } from "./databases.js";
export { Directory, DirectoryError, PeopleIndex, SERVER_PRINCIPAL, type PersonEntry } from "./directory/directory.js";
export { canonicalJson, mergePeople, mergeTwo } from "./directory/merge.js";
export { loginKey, personContent, readPerson, STATUSES, type Login, type Person, type Status } from "./directory/person.js";
export { checkIssuer, DiscoveryError } from "./oidc-discovery.js";
export { startServer, type RunningServer, type ServerOptions } from "./server.js";
export * from "./settings.js";
export { ServerDb, ServerDbError, SERVER_DB_FORMAT, type DatabaseRecord, type Identity } from "./store/server-db.js";
export { CertificateWatcher, loadTlsFiles, TlsError } from "./tls.js";
export { emailProblem, normalizeEmail } from "./text.js";
