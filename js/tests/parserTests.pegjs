/**
 * PEG.js grammar for reading MediaWiki parser tests files
 * 2011-07-20 Brion Vibber <brion@pobox.com>
 */

testfile =
    chunk+



eol = "\n"

whitespace = [ \t]+

ws = whitespace

rest_of_line = c:([^\n]*) eol
{
    return c.join('');
}

line = (!"!!") line:rest_of_line
{
    return line;
}

text = lines:line*
{
    return lines.join('\n');
}

chunk =
    comment /
    article /
    test /
    line /
    hooks /
    functionhooks



comment =
    "#" text:rest_of_line
{
    return {
        type: 'comment',
        comment: text
    }
}

empty =
    eol /
    ws eol
{
    return {
        type: 'empty'
    }
}



article =
    start_article title:line start_text text:text end_article
{
    return {
        type: 'article',
        title: title,
        text: text
    }
}

start_article =
    "!!" ws? "article" ws? eol

start_text =
    "!!" ws? "text" ws? eol

end_article =
    "!!" ws? "endarticle" ws? eol

// function hooks

functionhooks = start_functionhooks text:text end_functionhooks
{
    return {
        type: 'functionhooks',
        text: text
    }
}

start_functionhooks =
    "!!" ws? "functionhooks" ":"? ws? eol

end_functionhooks =
    "!!" ws? "endfunctionhooks" ":"? ws? eol

end_test =
    "!!" ws? "end" ws? eol

test =
    start_test
    title:text
    sections:(section / option_section)*
    end_test
{
    var test = {
        type: 'test',
        title: title
    };
    for (var i = 0; i < sections.length; i++) {
        var section = sections[i];
        test[section.name] = section.text;
    }
	return test;
}

section =
    "!!" ws? (!"end") (!"options") name:(c:[a-zA-Z0-9]+ { return c.join(''); }) rest_of_line
    text:text
{
    return {
        name: name,
        text: text
    };
}

option_section =
    "!!" ws? "options" ws? eol
    opts:option_list?
{
    var o = {};
    if (opts && opts.length) {
        for (var i = 0; i < opts.length; i++) {
            o[opts[i].k] = opts[i].v || '';
        }
    }
    return {
        name: "options",
        text: o
    };
}

option_list = o:an_option [ \t\n]+ rest:option_list?
{
    var result = [ o ];
    if (rest && rest.length) {
        result.push.apply(result, rest);
    }
    return result;
}

an_option = simple_option / prefix_option

simple_option = k:("pst"i / "msg"i / "cat"i / "ill"i / "subpage"i /
                   "noxml"i / "disabled"i / "showtitle"i / "comment"i /
                   "local"i / "rawhtml"i / "preload"i )
{
    return {k:k.toLowerCase()};
}
prefix_option = title_option / nospace_prefix_option

nospace_prefix_option = k:(c:[^ \t\n=]+ { return c.join(''); }) ws? "=" ws?
                  v:(c:[^ \t\n]+ { return c.join(''); })
{
    return {k:k, v:v};
}

title_option = k:"title" ws? "=" ws?
               v:("[[" (c:[^\]]+ { return c.join(''); }) "]]")
{
    return {k:k, v:"[["+v+"]]"};
}

/* the : is for a stray one, not sure it should be there */

start_test =
    "!!" ws? "test" ":"? ws? eol

end_test =
    "!!" ws? "end" ws? eol


hooks =
    start_hooks text:text end_hooks
{
    return {
        type: 'hooks',
        text: text
    }
}

start_hooks =
    "!!" ws? "hooks" ":"? ws? eol

end_hooks =
    "!!" ws? "endhooks" ws? eol
