package grids.engine;

/** A spreadsheet error value (#DIV/0!, #VALUE!, ...). The message is shown as a tooltip. */
public record GridError(String code, String message) {
    public GridError(String code) {
        this(code, "");
    }

    @Override
    public String toString() {
        return code;
    }
}
