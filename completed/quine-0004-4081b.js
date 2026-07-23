//                _                        _  _   
//    __ _ _   _(_)_ __   ___ _ __       _| || |_        quiner #4
//   / _` | | | | | '_ \ / _ \ '__|     |_  ..  _|   the four-mirror quine
//  | (_| | |_| | | | | |  __/ |        |_      _|
//   \__, |\__,_|_|_| |_|\___|_|          |_||_|   
//      |_|
//
//  Its ancestor, quiner #3, split itself into two territories:
//  a DATA half held in an array, and a CODE half that quoted
//  itself out of the runtime's mirror with Function.toString.
//  This program keeps that border but shatters the mirror into
//  FOUR shards, one per verb of self-reproduction:
//
//      line()  forges the one unquotable line -- the array's own
//              declaration -- fresh from JSON.stringify, since a
//              list cannot contain the sentence that creates it;
//      head()  unrolls the archive, swapping the sentinel "@L@"
//              for that forged line at exactly the right depth;
//      tail()  walks the four shards in order and asks each one,
//              politely, to recite its own source -- including,
//              in a small act of vertigo, tail() reciting tail();
//      main()  seams the halves together and speaks the whole.
//
//  Notice the strange loop in the third shard: tail() holds a
//  list [line, head, tail, main] that includes itself, so when
//  it maps toString over the list it is mid-execution while its
//  own text is being read back out of the mirror. The function
//  is simultaneously the reader and the page. No shard alone
//  knows the whole program; the quine only exists in the seam,
//  where the archive ends, the reflection begins, and four
//  small mirrors angle together into one closed circle of
//  light: a program whose entire output is the act of looking
//  at itself from four directions at once.
const L = ["//                _                        _  _   ","//    __ _ _   _(_)_ __   ___ _ __       _| || |_        quiner #4","//   / _` | | | | | '_ \\ / _ \\ '__|     |_  ..  _|   the four-mirror quine","//  | (_| | |_| | | | | |  __/ |        |_      _|","//   \\__, |\\__,_|_|_| |_|\\___|_|          |_||_|   ","//      |_|","//","//  Its ancestor, quiner #3, split itself into two territories:","//  a DATA half held in an array, and a CODE half that quoted","//  itself out of the runtime's mirror with Function.toString.","//  This program keeps that border but shatters the mirror into","//  FOUR shards, one per verb of self-reproduction:","//","//      line()  forges the one unquotable line -- the array's own","//              declaration -- fresh from JSON.stringify, since a","//              list cannot contain the sentence that creates it;","//      head()  unrolls the archive, swapping the sentinel \"@L@\"","//              for that forged line at exactly the right depth;","//      tail()  walks the four shards in order and asks each one,","//              politely, to recite its own source -- including,","//              in a small act of vertigo, tail() reciting tail();","//      main()  seams the halves together and speaks the whole.","//","//  Notice the strange loop in the third shard: tail() holds a","//  list [line, head, tail, main] that includes itself, so when","//  it maps toString over the list it is mid-execution while its","//  own text is being read back out of the mirror. The function","//  is simultaneously the reader and the page. No shard alone","//  knows the whole program; the quine only exists in the seam,","//  where the archive ends, the reflection begins, and four","//  small mirrors angle together into one closed circle of","//  light: a program whose entire output is the act of looking","//  at itself from four directions at once.","@L@"];
function line() { return "const L = " + JSON.stringify(L) + ";"; }
function head() { return L.map(function (l) { return l === "@L@" ? line() : l; }).join("\n"); }
function tail() { return [line, head, tail, main].map(function (f) { return f.toString(); }).join("\n"); }
function main() { console.log(head() + "\n" + tail() + "\nmain();"); }
main();
