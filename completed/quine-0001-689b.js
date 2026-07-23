//   __ _ _   _(_)_ __   ___ _ __     quiner #1
//  / _` | | | | | '_ \ / _ \ '__|    a program that prints itself,
// | (_| | |_| | | | | |  __/ |       banner and all, via JSON.stringify
//  \__, |\__,_|_|_| |_|\___|_|       of its own single-string payload.
//     |_|
const s = "//   __ _ _   _(_)_ __   ___ _ __     quiner #1\n//  / _` | | | | | '_ \\ / _ \\ '__|    a program that prints itself,\n// | (_| | |_| | | | | |  __/ |       banner and all, via JSON.stringify\n//  \\__, |\\__,_|_|_| |_|\\___|_|       of its own single-string payload.\n//     |_|\nconst s = %;\nconsole.log(s.replace('%', () => JSON.stringify(s)));";
console.log(s.replace('%', () => JSON.stringify(s)));
