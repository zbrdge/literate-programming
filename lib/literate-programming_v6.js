/*global require, module, process*/
/*jslint evil:true*/

var fs = require('fs');

// Define the ES5 String.trim() method if one does not already exist.
// This method returns a string with whitespace removed from the start and end.
String.prototype.trim = String.prototype.trim || function () {
  if (!this) return this; // Don't alter the empty string
  return this.replace(/^\s+|\s+$/g, ""); // Regular expression magic
};
String.prototype.rawString = String.prototype.rawString || function () {
  var ret = this;
  return function () {
    return ret;
  };
};
Array.prototype.trim = Array.prototype.trim || function () {
  var ret = [];
  var arr = this;
  var i, n = arr.length;
  for (i = 0; i < n; i += 1) {
    if (typeof arr[i].trim === "function") {
      ret[i] = arr[i].trim();
    }
  }
  return ret;
};
if (!Object.keys) {
  Object.keys = function (o) {
    if (o !== Object(o)) {
      throw new TypeError('Object.keys called on non-object');
    }
    var ret = [],
      p;
    for (p in o) {
      if (Object.prototype.hasOwnProperty.call(o, p)) {
        ret.push(p);
      }
    }
    return ret;
  };
}

var Block, Doc, repo = {
  plugins: {},
  litpro: {}
};

Doc = function (md, options) {

  this.litpro = md;
  this.blocks = {};
  this.cur = new Block();
  this.files = [];
  this.compiledFiles = {};
  this.logarr = [];
  this.subtimes = 0;
  this.type = ".";

  this.loading = {}; // for the LOAD and compile
  this.loaded = {}; // can reference this for external litpro by names. 
  this.waiting = {}; // place to put blocks waiting for compiling
  this.processing = 0; // Tracks status of processing. 
  this.call = []; // a list of functions to call upon a resume

  this.types = {
    "": "text/plain",
    css: "text/css"
  };

  this.directives = {
    "file": function (options) {
      var doc = this;
      var headname, internalname, litpro, arr, name;
      if (options[0] === "") {
        doc.log("No file name for file: " + options.join[" | "] + "," + doc.name);
        return false;
      } else {
        if (!options[1]) {
          options[1] = doc.name;
        }
        name = options[1].toLowerCase();
        arr = name.split("::").trim();
        if (arr.length === 1) {
          litpro = "";
          name = arr[0] || doc.name;
        } else {
          litpro = arr[0] || "";
          name = arr[1] || doc.name;
        }
        arr = name.split(":").trim();
        headname = arr[0] || doc.name;
        internalname = arr[1] || "";
        options[1] = [litpro, headname, internalname];
        doc.files.push(options);
      }
    },
    "version": function (options) {
      var doc = this;

      doc.addConstants({
        docname: (options[0] || ""),
        docversion: (options[1] || "0.0.0")
      });
    },
    "load": function (options) {
      var doc = this;
      var fname = options.shift();
      if (!fname) {
        doc.log("Error in LOAD. Please give a filename " + options.join(" | "));
        return false;
      }
      var name = options.shift();
      if (!name) {
        name = fname;
      }
      var newdoc;
      if (doc.repo.hasOwnProperty(fname)) {
        if (Array.isArray(doc.repo[fname])) {
          // loading
          doc.repo[fname].push([doc, name]);
          doc.loading[name] = true;
        } else {
          // already loaded
          newdoc = doc.repo[fname];
          doc.loaded[name] = newdoc;
          newdoc.parents.push([doc, name]);
        }
        return true;
      } else {
        // never seen before
        doc.repo[name] = [doc, name];
        doc.loading[name] = true;
      }
      var file, i, n, par;
      file = fs.readFile(fname, 'utf8', function (err, data) {
        var tempdoc, tempname, newdoc;
        if (err) {
          doc.log("Issue with LOAD: " + fname + " " + name + " " + err.message);
          par = doc.repo[fname];
          delete doc.repo[fname];
          n = par.length;
          for (i = 0; i < n; i += 1) {
            tempdoc = par[i][0];
            tempname = par[i][1];
            delete tempdoc.loading[tempname];
            // may want to abort instead?
            if (Object.keys(doc.loading).length === 0) {
              doc.compile();
            }
          }
        } else {
          par = doc.repo[fname];
          newdoc = doc.repo[name] = (new Doc(data, {
            standardPlugins: doc.standardPlugins,
            postCompile: doc.postCompile,
            filterCompileFiles: options,
            parents: par,
            fromFile: fname
          }));
          n = par.length;
          for (i = 0; i < n; i += 1) {
            tempdoc = par[i][0];
            tempname = par[i][1];
            delete tempdoc.loading[tempname];
            tempdoc.loaded[tempname] = newdoc;
            if (Object.keys(doc.loading).length === 0) {
              doc.compile();
            }
          }

        }
      });
      return true;
    },
    "require": function (options) {
      var doc = this;
      var name = options.shift();
      if (!name) {
        doc.log("Error in REQUIRE. Please give a module filename " + options.join(" | "));
        return false;
      }
      var bits;
      try {
        if (name[0] === "/") {
          name = process.cwd() + name;
        }
        bits = require(name);
      } catch (e) {
        doc.log("Issue with REQUIRE: " + name + " " + options + " " + e.message);
        return false;
      }
      var bit;
      if (options.length === 0) {
        for (bit in bits) {
          if ((bits.hasOwnProperty(bit)) && (typeof bits[bit] === "function")) {
            bits[bit](doc); //each one is responsible for modifying
          }
        }
      } else {
        var i, n = options.length;
        for (i = 0; i < n; i += 1) {
          bit = options[i];
          if ((bits.hasOwnProperty(bit)) && (typeof bits[bit] === "function")) {
            bits[bit](doc); //each one is responsible for modifying
          }
        }
      }
    },
    "set": function (options) {
      var doc = this;
      if (options.length >= 2) {
        var name = options[0].toLowerCase();
        var newc = {};
        newc[name] = options.slice(1).join("|"); // a hack to undo pipe splitting--loses whitespacing
        doc.addConstants(newc);
      } else {
        doc.log("Error with SET directive. Need exactly 2 arguments.");
      }
    },
    "define": function (options) {
      var doc = this;
      var cur = doc.cur;
      var code;
      var fname = options.shift().toLowerCase();
      if (!fname) {
        doc.log("Error with DEFINE directive. Need a name.");
        return false;
      }
      code = cur.code[cur.type].join("\n");
      var macrof;
      eval("macrof=" + code);
      var newm = {};
      newm[fname] = macrof;
      doc.addMacros(newm);
    }
  };

  this.commander = function (commands, code, passin, final) {
    var i = 0,
      n = commands.length,
      command;
    var next = function () {
      if (i < n) {
        var command = commands[i];
        doc.callback = false;
        i += 1; // prime it for next loop
        var temp = command[0].call(passin, code, command[1], next);

        if (!passin.callback) {
          code = temp;
          next();
        }
      } else {
        // all done
        final.call(passin, code);
      }
    };

    next(); // begin!

    return null;
  };
  this.commands = {
    "eval": function (code) {
      try {
        this.state.obj = eval("(function(){" + code + "})()");
        if (typeof this.state.obj === "undefined") {
          return "";
        } else {
          return this.state.obj.toString();
        }
      } catch (e) {
        this.doc.log("Eval error: " + e + "\n" + code);
        return "";
      }
    },
    "nocompile": function () {
      return "";
    },
    "raw": function () {
      var block = this.block;

      return block.full.join("\n");
    },
    "clean raw": function () {
      var block = this.block;
      var full = block.full;
      var i, n = full.length,
        ret = [],
        line;
      for (i = 0; i < n; i += 1) {
        line = full[i];
        if (line.match(/^(?:\#|\.[A-Z]|[A-Z]{2})/)) {
          continue;
        }
        if (line.match(/^ (?:\#|[A-Z.])/)) {
          ret.push(line.slice(1));
        } else {
          ret.push(line);
        }
      }
      return (ret.join("\n")).trim();
    },
    "indent": function (code, options) {
      var begin, middle;
      if (options.length === 2) {
        begin = Array(parseInt(options[0], 10) + 1).join(" ");
        middle = "\n" + Array(parseInt(options[1], 10) + 1).join(" ");
      } else if (options.length === 1) {
        begin = "";
        middle = "\n" + Array(parseInt(options[0], 10) + 1).join(" ");
      } else {
        this.state.indented = true;
        return code;
      }
      code = begin + code.replace("\n", middle);
      this.state.indented = true;
      return code;
    },
    "log": function (code, options) {
      var doc = this.doc;
      var name = this.name;
      if (options[0]) {
        doc.log(options[0] + "\n" + code);
      } else {
        doc.log(name + ":\n" + code);
      }
      return code;
    },
    "substitute": function (code, options) {
      var i, n = options.length,
        reg;
      for (i = 0; i < n; i += 2) {
        if (!options[i + 1]) {
          break; // should only happen if n is odd
        }
        reg = new RegExp(options[i], "g"); // global replace
        code = code.replace(reg, options[i + 1]);
      }
      return code;
    },
    "stringify": function (code) {
      code = code.replace(/\\/g, '\\\\');
      code = code.replace(/"/g, '\\' + '"');
      var arr = code.split("\n");
      var i, n = arr.length;
      for (i = 0; i < n; i += 1) {
        arr[i] = '"' + arr[i] + '"';
      }
      code = "[" + arr.join(",\n") + '].join("\\n")';
      return code;
    }
  };

  this.macros = {};

  this.repo = repo; // defined in module scope; 

  this.processors = [].concat(this.defaultProcessors);


  if (options) {
    var key;
    for (key in options) {
      this[key] = options[key];
    }
  }

  this.addPlugins(this.standardPlugins);
  this.parseLines(); // which then initiates .compile().process().end(); 

  return this;
};

Doc.prototype.defaultIndent = "    ";

Doc.prototype.maxsub = 1e5;

Doc.prototype.oneSub = function oneSub(codeBlocks, name, block) {

  var doc = this;

  if (doc.subtimes >= doc.maxsub) {
    doc.log("maxed out", block.name);
    return false;
  } else {
    doc.subtimes += 1;
  }


  var code = codeBlocks[name];

  var reg = /(?:(\_+)(?:(?:\"([^"]+)\")|(?:\`([^`]+)\`))|(?:([A-Z][A-Z.]*[A-Z])(?:\(([^)]*)\))?))/g;
  var rep = [];
  var match, ret, type, pieces, where, comp, lower, args, otherdoc, litpro, internal, state;
  var ind, linetext, middle, space, spacereg = /^(\s*)/;

  var blocks = doc.blocks;

  while ((match = reg.exec(code)) !== null) {
    internal = '';
    litpro = '';
    if (match[2]) {

      //split off the piping
      pieces = match[2].split("|").trim();
      where = pieces.shift().toLowerCase();

      if (where) {
        where = where.split("::").trim();
        if (where.length === 1) {
          where = where[0];
        } else {
          litpro = where[0];
          where = where[1];
        }
        where = where.split(":").trim();
        if (where.length === 1) {
          where = where[0];
        } else {

          internal = where[1];
          where = where[0];
        }
        if (litpro) {
          if (doc.repo.hasOwnProperty(litpro)) {
            otherdoc = doc.repo[litpro];
            if (otherdoc.blocks.hasOwnProperty(where)) {
              comp = otherdoc.blocks[where].compiled;
            } else {
              doc.log("No such block " + where + " in literate program " + litpro);
              continue;
            }
          } else {
            doc.log("No such literate program loaded: " + litpro);
            continue;
          }
        } else {
          // this doc
          if (where) {
            if (doc.blocks.hasOwnProperty(where)) {
              if (match[1] && match[1].length > 1) {
                rep.push([match[0], match[0].slice(1)]);
                continue;
              }
              comp = doc.fullSub(blocks[where]);
            } else {
              // no block to substitute; ignore
              continue;
            }
          } else {
            // use the code already compiled in codeBlocks
            if (match[1] && match[1].length > 1) {
              rep.push([match[0], match[0].slice(1)]);
              continue;
            }
            comp = codeBlocks;
          }
        }
      } else {
        // use the code already compiled in codeBlocks
        if (match[1] && match[1].length > 1) {
          rep.push([match[0], match[0].slice(1)]);
          continue;
        }
        comp = codeBlocks;
      }

      internal = (internal || "").trim();
      ret = doc.getBlock(comp, internal, name || "", block.name);
      state = {};
      ret = doc.piping.call({
        doc: doc,
        block: block,
        name: where + (type || ""),
        state: state
      }, pieces, ret);

      if (!state.indent) {
        ind = match.index - 1;
        while (ind > 0) {
          if (code[ind] === "\n") {
            break;
          } else {
            ind -= 1;
          }

        }
        if (ind === 0 || ind === match.index - 1) {
          // no indent
        } else {
          linetext = code.slice(ind + 1, match.index);
          space = linetext.match(spacereg);
          if (space[1].length === linetext.length) {
            //all spaces
            middle = space[1];
          } else {
            middle = space[1] + doc.defaultIndent;
          }
          ret = ret.replace(/\n/g, "\n" + middle);
        }
      }

      rep.push([match[0], ret]);

    } else if (match[3]) {
      // code
      if (match[1] && match[1].length > 1) {
        rep.push([match[0], match[0].slice(1)]);
        continue;
      }

      rep.push([match[0], eval(match[3])]);

    } else {
      // constant
      lower = match[4].toLowerCase();
      args = (match[5] || "").split(',').trim();
      if (doc.macros.hasOwnProperty(lower)) {
        rep.push([match[0], doc.macros[lower].apply(doc, args)]);
      }
    }
  }

  //do the replacements or return false
  if (rep.length > 0) {
    for (var i = 0; i < rep.length; i += 1) {
      if (typeof rep[i][1] === "string") {
        code = code.replace(rep[i][0], rep[i][1].rawString());
      } else {
        doc.log(rep[i][0], rep[i][1]);
        return 0;
      }
    }
    codeBlocks[name] = code;

    return 1;

  } else {
    return 0;
  }
};
Doc.prototype.fullSub = function fullSub(block) {
  var doc = this;
  var name;
  var code = {}, blockCode;

  if (block.hasOwnProperty("compiled")) {
    return block.compiled;
  } else {
    block.compiled = {};
  }

  for (name in block.code) {
    blockCode = block.code[name];
    code[name] = blockCode.join("\n");
    if (blockCode.commands.hasOwnProperty(0)) {
      code[name] = doc.commander(blockCode.commands[0], code[name]);
    }

  }

  var counter = 0,
    go = 1;
  while (go) {
    go = 0;
    counter += 1;
    for (name in code) {
      go += doc.oneSub(code, name, block);

      blockCode = block.code[name];

      if (blockCode.commands.hasOwnProperty(counter)) {
        code[name] = doc.commander(blockCode.commands[counter], code[name]);
      }
    }
  }


  for (name in code) {
    blockCode = block.code[name];

    if (blockCode.commands.hasOwnProperty("Infinity")) {
      code[name] = doc.commander(blockCode.commands["Infinity"], code[name]);
    }
    block.compiled[name] = code[name];
  }

  return block.compiled;
};

Doc.prototype.defaultProcessors = [

function (line, doc) {
  var cur = doc.cur;
  var reg = /^(?: {4}|(?:\t {4}))(.*)$/;
  var match = reg.exec(line);
  if (match) {
    cur.code[cur.type].push(match[1]);
    return true;

  } else if (line.match(/^\s*$/)) {
    var carr = cur.code[cur.type];
    if (carr && carr.length > 0 && carr[carr.length - 1] !== "") {
      cur.code[cur.type].push(line);
    }
    return false; // so that it can be added to the plain parser as well

  } else {
    return false;
  }
},

function (line, doc) {
  var level, oldLevel, cur, name;
  var head = /^(\#+)\s*(.+)$/;
  var match = head.exec(line);
  if (match) {
    name = match[2].trim().toLowerCase();
    oldLevel = doc.level || 0;
    level = match[1].length;

    var cname;
    var old = doc.cur;
    for (cname in old.code) {
      if (old.code[cname].length === 0) {
        delete old.code[cname];
      }
    }

    cur = new Block();
    cur.name = name;
    cur.type = doc.type;
    cur.code[cur.type] = doc.makeCode();

    doc.blocks[name] = cur;
    doc.cur = cur;
    doc.level = level;
    doc.name = name;
    // new processors for each section
    doc.processors = [].concat(doc.defaultProcessors);

    return true;
  }
  return false;
},

function (line, doc) {

  var fileext = /^\.([A-Z]*)(?:$|\s+(.*)$)/;
  var match = fileext.exec(line);
  if (match) {
    doc.switchType(match[1], match[2]);
    return true;
  }

  var reg = /^([A-Z][A-Z\.]*[A-Z])(?:$|\s+(.*)$)/;
  var options, name;
  match = reg.exec(line);
  if (match) {
    name = match[1].toLowerCase();
    if (doc.directives.hasOwnProperty(name)) {
      options = (match[2] || "").split("|").trim();
      doc.directives[name].call(doc, options);
      return true;
    } else if (doc.types.hasOwnProperty(name)) {
      doc.switchType(match[1], match[2]);
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
},

function (line, doc) {
  doc.cur.plain.push(line);
  return true;
}];

Doc.prototype.switchType = function (type, options) {
  var doc = this;
  var cur = doc.cur;

  type = type.toLowerCase();
  if (typeof options === "undefined") {
    options = "";
  }
  options = options.split("|").trim();
  var name = options.shift();
  if (name) {
    name.trim();
    cur.type = name.toLowerCase() + "." + type;
  } else {
    cur.type = "." + type;
  }

  if (!cur.code.hasOwnProperty(cur.type)) {
    cur.code[cur.type] = doc.makeCode();
  }

  var codearr = cur.code[cur.type];

  var passin = {
    doc: doc,
    block: cur,
    type: type,
    name: name,
    state: {}
  }; // for command stuff

  var funname, ind, funargs, match, funreg = /^(\d*)\s*([^(]+)(?:\(([^)]*)\))?$/;
  var i, n = options.length,
    option;
  for (i = 0; i < n; i += 1) {
    option = options[i].trim();
    match = option.match(funreg);
    if (match === null) {
      doc.log("Failed parsing (" + name + " ): " + option);
      continue;
    }

    funname = match[2].trim();

    if (match[3]) {
      funargs = match[3].split(",").trim();
    } else {
      funargs = [];
    }

    if (match[1]) {
      ind = parseInt(match[1], 10);
    } else {
      ind = "Infinity";
    }

    if (doc.commands.hasOwnProperty(funname)) {

      if (codearr.commands.hasOwnProperty(ind)) {
        codearr.commands[ind].push([doc.commands[funname], funargs, passin]);
      } else {
        codearr.commands[ind] = [
          [doc.commands[funname], funargs, passin]
        ];
      }
    }
  }

};

Doc.prototype.makeCode = function () {
  var doc = this;
  var ret = [];
  ret.commands = {
    0: [doc.trimCode]
  };
  return ret;
};

Doc.prototype.trimCode = [function (code) {
  return code.trim();
}, [], {}];

Doc.prototype.log = function (text) {
  this.logarr.push(text);
};

Doc.prototype.parseLines = function () {
  var doc = this;
  var i, line, nn;

  var lines = doc.litpro.split("\n");
  doc.cur.level = 0;
  var n = lines.length;
  for (i = 0; i < n; i += 1) {
    line = lines[i];
    nn = doc.processors.length;
    for (var ii = 0; ii < nn; ii += 1) {
      if (doc.processors[ii](line, doc)) {
        doc.cur.full.push(line);
        break;
      }
    }
  }

  var cname;
  var old = doc.cur;
  for (cname in old.code) {
    if (old.code[cname].length === 0) {
      delete old.code[cname];
    }
  }

  if (Object.keys(doc.loading).length === 0) {
    doc.compile();
  }

  return doc;
};

Doc.prototype.getBlock = function (block, internal, requester, bname) {
  var doc = this;

  internal = internal.toLowerCase();
  requester = requester.toLowerCase();

  // an exact match! yay!
  if (block.hasOwnProperty(internal)) {
    return block[internal];
  }

  var keys = Object.keys(block);

  // just one key
  if (keys.length === 1) {
    return block[keys[0]];
  }

  // no code segments
  if (keys.length === 0) {
    return "";
  }

  if (doc.types.hasOwnProperty(internal)) {
    // main.js
    if (block.hasOwnProperty("main." + internal)) {
      return block["main." + internal];
    }
    // .js
    if (block.hasOwnProperty(internal)) {
      return block["." + internal];
    }
  }

  // try and find a match for the internal
  var newkeys = keys.filter(function (val) {
    if (val.match(internal)) {
      return true;
    } else {
      return false;
    }
  });

  if (newkeys.length === 1) {
    return block[newkeys[0]];
  }

  if (newkeys.length === 0) {
    doc.log("Name not found: " + internal + " requested from " + requester + " of " + bname);
    return "";
  }

  //so we have multiple matches to internal (internal could be "")
  // get extension from requester

  var ext = (requester.split(".")[1] || "").trim().toLowerCase();

  var extkeys = newkeys.filter(function (val) {
    if (val.match(ext)) {
      return true;
    } else {
      return false;
    }
  });

  if (extkeys.length === 1) {
    return block[extkeys[0]];
  }

  var finalkeys;
  if (extkeys.length > 0) {
    finalkeys = extkeys;
  } else {
    finalkeys = newkeys;
  }

  var morekeys = finalkeys.filter(function (val) {
    if (val.match("main")) {
      return true;
    } else {
      return false;
    }
  });

  if (morekeys.length > 0) {
    return block[morekeys[0]];
  }

  // pick shortest one which could be the empty name
  return block[finalkeys.sort(function (a, b) {
    if (a.length < b.length) {
      return -1;
    } else {
      return 1;
    }
  })[0]];

};

Doc.prototype.compile = function () {
  var doc = this;

  var blockname;
  for (blockname in doc.blocks) {
    doc.fullSub(doc.blocks[blockname]);
  }

  if (Object.keys(doc.waiting).length === 0) {
    doc.process();
  }

  return doc;
};

Doc.prototype.addConstants = function (obj) {
  var doc = this;
  var name;
  var newobj = {};
  for (name in obj) {
    newobj[name] = doc.wrapVal(obj[name]);
  }
  doc.addMacros(newobj);
};

Doc.prototype.wrapVal = function (val) {
  return function () {
    return val;
  };
};

Doc.prototype.piping = function (pieces, code, final) {

  var doc = this.doc;
  var passin = this;

  var com, cmatch, funname, funargs, comreg = /^\s*([^(]+)(?:\(([^)]*)\))?$/,
    comarr;

  comarr = [];

  while (pieces.length > 0) {

    com = pieces.shift();

    cmatch = com.match(comreg);

    if (com === null) {
      doc.log("No match " + com);
      continue;
    }

    funname = cmatch[1].trim();

    if (cmatch[2]) {
      funargs = cmatch[2].split(",").trim();
    } else {
      funargs = [];
    }

    if (doc.commands.hasOwnProperty(funname)) {
      comarr.push([doc.commands[funname], funargs]);
    } else {
      doc.log("Issue with " + com);
    }
  }

  doc.commander(comarr, code, passin, final);

  return null;
};

Doc.prototype.addMacros = function (newobj) {
  var doc = this;
  var oldobj = doc.macros;
  var name;
  for (name in newobj) {
    if (oldobj.hasOwnProperty(name)) {
      doc.log("Replacing " + name);
    }
    oldobj[name] = newobj[name];
  }
};

Doc.prototype.addCommands = function (newobj) {
  var doc = this;
  var oldobj = doc.commands;
  var name;
  for (name in newobj) {
    if (oldobj.hasOwnProperty(name)) {
      doc.log("Replacing " + name);
    }
    oldobj[name] = newobj[name];
  }
};

Doc.prototype.addTypes = function (newobj) {
  var doc = this;
  var oldobj = doc.types;
  var name;
  for (name in newobj) {
    if (oldobj.hasOwnProperty(name)) {
      doc.log("Replacing " + name);
    }
    oldobj[name] = newobj[name];
  }
};

Doc.prototype.addDirectives = function (newobj) {
  var doc = this;
  var oldobj = doc.directives;
  var name;
  for (name in newobj) {
    if (oldobj.hasOwnProperty(name)) {
      doc.log("Replacing " + name);
    }
    oldobj[name] = newobj[name];
  }
};

Doc.prototype.addPlugins = function (plugobj) {
  var doc = this;
  if (!plugobj) {
    return false;
  }
  var type;
  for (type in plugobj) {
    if ((plugobj.hasOwnProperty(type)) && (typeof plugobj[type] === "function")) {
      plugobj[type](doc); //each one is responsible for modifying
    }
  }
  return true;
};

Doc.prototype.process = function () {
  var doc = this;

  var files = doc.files;
  var cFiles = doc.compiledFiles = {};
  var file, block, fname, compiled, text, litpro, headname, internal, fdoc;
  var i, n = files.length,
    passin;
  var final = function (text) {
    var doc = this.doc;
    var fname = this.name;
    cFiles[fname] = text;
    doc.processing -= 1;
    if (doc.processing < 1) {
      doc.end();
    }
  };
  doc.processing = n;

  for (i = 0; i < n; i += 1) {
    file = files[i];
    fname = file[0];
    litpro = file[1][0];
    headname = file[1][1];
    internal = file[1][2];
    if (litpro) {
      if (doc.repo.hasOwnProperty(litpro)) {
        fdoc = doc.repo[litpro];
      } else {
        doc.log(fname + " is trying to use non-loaded literate program " + litpro);
        continue;
      }
    } else {
      fdoc = doc;
    }
    if (headname) {
      if (fdoc.blocks.hasOwnProperty(headname)) {
        block = fdoc.blocks[headname];
      } else {
        doc.log(fname + " is trying to load non existent block '" + headname + "'");
        continue;
      }
    } else {
      doc.log(fname + " has no block " + litpro + " :: " + headname);
      continue;
    }
    compiled = block.compiled;
    text = fdoc.getBlock(compiled, internal, fname, block.name);
    passin = {
      doc: fdoc,
      block: fdoc.blocks[block.name],
      name: fname
    };
    fdoc.piping.call(passin, file.slice(2), text, final)();
  }

  return doc;
};

Doc.prototype.end = function () {

  var doc = this;
  var pc = doc.postCompile;
  var i, n = pc.length,
    fun, obj;
  for (i = 0; i < n; i += 1) {
    fun = pc[i][0];
    obj = pc[i][1];
    fun.call(doc, obj);
  }

  return doc;
};

Block = function () {

  this.code = {};
  this.full = [];
  this.plain = [];

  return this;
};

module.exports.Doc = Doc;