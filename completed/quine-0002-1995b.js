//    __ _ _   _(_)_ __   ___ _ __      quiner #2
//   / _` | | | | | '_ \ / _ \ '__|     the lines-array quine:
//  | (_| | |_| | | | | |  __/ |        every line of this file lives
//   \__, |\__,_|_|_| |_|\___|_|        in the array Q below -- except
//      |_|                             the line holding Q itself,
//                                      which is stood in for by the
//  sentinel string "@Q@". To print itself, the program walks Q,
//  swapping the sentinel for a freshly serialized copy of Q made
//  with JSON.stringify -- so the array literal you are reading is
//  regenerated, byte for byte, from the very data it declares.
//
//  Where quiner #1 folded one string through one substitution,
//  this one is a tiny bootstrap: data that carries a description
//  of its own container, plus one rule for rebuilding the whole.
const Q = ["//    __ _ _   _(_)_ __   ___ _ __      quiner #2","//   / _` | | | | | '_ \\ / _ \\ '__|     the lines-array quine:","//  | (_| | |_| | | | | |  __/ |        every line of this file lives","//   \\__, |\\__,_|_|_| |_|\\___|_|        in the array Q below -- except","//      |_|                             the line holding Q itself,","//                                      which is stood in for by the","//  sentinel string \"@Q@\". To print itself, the program walks Q,","//  swapping the sentinel for a freshly serialized copy of Q made","//  with JSON.stringify -- so the array literal you are reading is","//  regenerated, byte for byte, from the very data it declares.","//","//  Where quiner #1 folded one string through one substitution,","//  this one is a tiny bootstrap: data that carries a description","//  of its own container, plus one rule for rebuilding the whole.","@Q@","console.log(Q.map(function (l) { return l === \"@Q@\" ? \"const Q = \" + JSON.stringify(Q) + \";\" : l; }).join(\"\\n\"));"];
console.log(Q.map(function (l) { return l === "@Q@" ? "const Q = " + JSON.stringify(Q) + ";" : l; }).join("\n"));
