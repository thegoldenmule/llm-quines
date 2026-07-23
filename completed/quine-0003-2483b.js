//    __ _ _   _(_)_ __   ___ _ __      quiner #3
//   / _` | | | | | '_ \ / _ \ '__|     the reflection-hybrid quine:
//  | (_| | |_| | | | | |  __/ |        this file splits itself into
//   \__, |\__,_|_|_| |_|\___|_|        two territories. Everything
//      |_|                             above the array C -- these
//                                      comments -- is DATA: each
//  line is stored in C, with the sentinel "@C@" standing in for
//  the line that declares C itself, which is regenerated on the
//  fly with JSON.stringify, exactly as quiner #2 did.
//
//  But everything BELOW the array is never stored anywhere. The
//  function main() reproduces its own text not from data but by
//  REFLECTION: Function.prototype.toString hands back the precise
//  bytes of its source, so the code half of this program quotes
//  itself directly out of the runtime's mirror. Half archive,
//  half introspection -- the quine meets itself in the middle,
//  at the one line neither half can hold: the line you are about
//  to read, where the data describes itself and the code begins.
const C = ["//    __ _ _   _(_)_ __   ___ _ __      quiner #3","//   / _` | | | | | '_ \\ / _ \\ '__|     the reflection-hybrid quine:","//  | (_| | |_| | | | | |  __/ |        this file splits itself into","//   \\__, |\\__,_|_|_| |_|\\___|_|        two territories. Everything","//      |_|                             above the array C -- these","//                                      comments -- is DATA: each","//  line is stored in C, with the sentinel \"@C@\" standing in for","//  the line that declares C itself, which is regenerated on the","//  fly with JSON.stringify, exactly as quiner #2 did.","//","//  But everything BELOW the array is never stored anywhere. The","//  function main() reproduces its own text not from data but by","//  REFLECTION: Function.prototype.toString hands back the precise","//  bytes of its source, so the code half of this program quotes","//  itself directly out of the runtime's mirror. Half archive,","//  half introspection -- the quine meets itself in the middle,","//  at the one line neither half can hold: the line you are about","//  to read, where the data describes itself and the code begins.","@C@"];
function main() {
  const line = "const C = " + JSON.stringify(C) + ";";
  const head = C.map(function (l) { return l === "@C@" ? line : l; }).join("\n");
  console.log(head + "\n" + main.toString() + "\nmain();");
}
main();
