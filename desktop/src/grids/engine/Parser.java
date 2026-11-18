package grids.engine;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Formula text (without "=") -> AST. Mirrors web/public/engine/parser.js; grammar in shared/FORMULAS.md. */
public final class Parser {

    public sealed interface Node permits Num, Str, Bool, RefNode, RangeNode, Call, Bin, Neg, Pct {}
    public record Num(double v) implements Node {}
    public record Str(String v) implements Node {}
    public record Bool(boolean v) implements Node {}
    public record RefNode(int col, int row) implements Node {}
    public record RangeNode(int c1, int r1, int c2, int r2) implements Node {}
    public record Call(String name, List<Node> args) implements Node {}
    public record Bin(String op, Node l, Node r) implements Node {}
    public record Neg(Node e) implements Node {}
    public record Pct(Node e) implements Node {}

    public static final class ParseError extends Exception {
        public ParseError(String message) {
            super(message);
        }
    }

    private enum Kind { NUM, STR, REF, IDENT, OP, EOF }

    private record Tok(Kind k, String v) {}

    private static final Pattern NUM = Pattern.compile("^(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?");
    private static final Pattern REF = Pattern.compile("^\\$?[A-Za-z]{1,3}\\$?[0-9]+");
    private static final Pattern IDENT = Pattern.compile("^[A-Za-z_][A-Za-z0-9_.]*");
    private static final String[] OPS = {"<=", ">=", "<>", "+", "-", "*", "/", "^", "&", "=", "<", ">", "%", "(", ")", ",", ":"};

    private final List<Tok> toks;
    private int p = 0;

    private Parser(List<Tok> toks) {
        this.toks = toks;
    }

    public static Node parse(String src) throws ParseError {
        Parser ps = new Parser(tokenize(src));
        Node n = ps.comparison();
        if (ps.peek().k() != Kind.EOF) throw new ParseError("Unexpected \"" + ps.peek().v() + "\"");
        return n;
    }

    static List<Tok> tokenize(String src) throws ParseError {
        List<Tok> out = new ArrayList<>();
        int i = 0;
        while (i < src.length()) {
            char ch = src.charAt(i);
            if (Character.isWhitespace(ch)) {
                i++;
                continue;
            }
            String rest = src.substring(i);
            if (ch == '"') {
                StringBuilder s = new StringBuilder();
                int j = i + 1;
                while (true) {
                    if (j >= src.length()) throw new ParseError("Unterminated string");
                    if (src.charAt(j) == '"') {
                        if (j + 1 < src.length() && src.charAt(j + 1) == '"') {
                            s.append('"');
                            j += 2;
                            continue;
                        }
                        break;
                    }
                    s.append(src.charAt(j++));
                }
                out.add(new Tok(Kind.STR, s.toString()));
                i = j + 1;
                continue;
            }
            Matcher m = NUM.matcher(rest);
            if (m.find()) {
                out.add(new Tok(Kind.NUM, m.group()));
                i += m.group().length();
                continue;
            }
            m = REF.matcher(rest);
            if (m.find()) {
                int end = i + m.group().length();
                boolean call = end < src.length() && src.charAt(end) == '(';
                boolean longer = IDENT.matcher(src.substring(end)).find();
                if (!call && !longer) {
                    out.add(new Tok(Kind.REF, m.group()));
                    i = end;
                    continue;
                }
            }
            m = IDENT.matcher(rest);
            if (m.find()) {
                out.add(new Tok(Kind.IDENT, m.group()));
                i += m.group().length();
                continue;
            }
            String op = null;
            for (String o : OPS) {
                if (rest.startsWith(o)) {
                    op = o;
                    break;
                }
            }
            if (op == null) throw new ParseError("Unexpected character \"" + ch + "\"");
            out.add(new Tok(Kind.OP, op));
            i += op.length();
        }
        out.add(new Tok(Kind.EOF, ""));
        return out;
    }

    private Tok peek() {
        return toks.get(p);
    }

    private Tok take() {
        return toks.get(p++);
    }

    private boolean isOp(String... ops) {
        Tok t = peek();
        if (t.k() != Kind.OP) return false;
        for (String o : ops) if (o.equals(t.v())) return true;
        return false;
    }

    private void expect(String v) throws ParseError {
        if (!isOp(v)) throw new ParseError("Expected \"" + v + "\"");
        take();
    }

    private Node comparison() throws ParseError {
        Node l = concat();
        while (isOp("=", "<>", "<", ">", "<=", ">=")) l = new Bin(take().v(), l, concat());
        return l;
    }

    private Node concat() throws ParseError {
        Node l = additive();
        while (isOp("&")) {
            take();
            l = new Bin("&", l, additive());
        }
        return l;
    }

    private Node additive() throws ParseError {
        Node l = term();
        while (isOp("+", "-")) l = new Bin(take().v(), l, term());
        return l;
    }

    private Node term() throws ParseError {
        Node l = power();
        while (isOp("*", "/")) l = new Bin(take().v(), l, power());
        return l;
    }

    private Node power() throws ParseError {
        Node l = unary();
        while (isOp("^")) {
            take();
            l = new Bin("^", l, unary());
        }
        return l;
    }

    private Node unary() throws ParseError {
        if (isOp("-")) {
            take();
            return new Neg(unary());
        }
        if (isOp("+")) {
            take();
            return unary();
        }
        return postfix();
    }

    private Node postfix() throws ParseError {
        Node e = primary();
        while (isOp("%")) {
            take();
            e = new Pct(e);
        }
        return e;
    }

    private Node primary() throws ParseError {
        Tok tok = take();
        switch (tok.k()) {
            case NUM:
                return new Num(Double.parseDouble(tok.v()));
            case STR:
                return new Str(tok.v());
            case REF: {
                Refs.Ref a = Refs.parseRef(tok.v());
                if (a == null) throw new ParseError("Bad reference " + tok.v());
                if (isOp(":")) {
                    take();
                    Tok t2 = take();
                    Refs.Ref b = t2.k() == Kind.REF ? Refs.parseRef(t2.v()) : null;
                    if (b == null) throw new ParseError("Bad range");
                    RangeNode r = new RangeNode(Math.min(a.col(), b.col()), Math.min(a.row(), b.row()), Math.max(a.col(), b.col()), Math.max(a.row(), b.row()));
                    if ((long) (r.c2() - r.c1() + 1) * (r.r2() - r.r1() + 1) > Refs.MAX_RANGE_CELLS) throw new ParseError("Range too large");
                    return r;
                }
                return new RefNode(a.col(), a.row());
            }
            case IDENT: {
                String name = tok.v().toUpperCase(Locale.ROOT);
                if (isOp("(")) {
                    take();
                    List<Node> args = new ArrayList<>();
                    if (!isOp(")")) {
                        args.add(comparison());
                        while (isOp(",")) {
                            take();
                            args.add(comparison());
                        }
                    }
                    expect(")");
                    return new Call(name, args);
                }
                if (name.equals("TRUE") || name.equals("FALSE")) return new Bool(name.equals("TRUE"));
                throw new ParseError("Unknown name " + tok.v());
            }
            case OP:
                if (tok.v().equals("(")) {
                    Node e = comparison();
                    expect(")");
                    return e;
                }
                throw new ParseError("Unexpected \"" + tok.v() + "\"");
            default:
                throw new ParseError("Unexpected end of formula");
        }
    }
}
