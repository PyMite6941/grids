package grids.ui;

import grids.app.Document;
import grids.engine.GridError;
import grids.engine.Refs;
import grids.model.CellFormat;
import java.awt.Color;
import java.awt.Component;
import java.awt.Font;
import java.awt.event.KeyEvent;
import java.util.EventObject;
import javax.swing.BorderFactory;
import javax.swing.DefaultCellEditor;
import javax.swing.JTable;
import javax.swing.JTextField;
import javax.swing.ListSelectionModel;
import javax.swing.SwingConstants;
import javax.swing.UIManager;
import javax.swing.border.Border;
import javax.swing.table.AbstractTableModel;
import javax.swing.table.DefaultTableCellRenderer;
import javax.swing.table.TableColumn;

/** The grid: a JTable whose model reads straight from the Document. */
public final class SheetTable extends JTable {
    static final int DEFAULT_WIDTH = 100;
    static final Color ERR = new Color(0xc0392b);
    static final Color BUSY = new Color(0x8a8f98);
    static final Color PY = new Color(0x3a6fd8);

    private final Document doc;
    final Model model;
    private EventObject editTrigger;

    final class Model extends AbstractTableModel {
        int rows = 100;
        int cols = 26;

        /** Grow to fit content (+ margin). Returns true if the column count changed. */
        boolean fit() {
            int[] ext = doc.extent();
            int r = Math.max(rows, ((ext[0] + 20) / 50 + 1) * 50);
            int c = Math.max(cols, ext[1] + 3);
            boolean colsChanged = c != cols;
            rows = r;
            cols = c;
            return colsChanged;
        }

        @Override
        public int getRowCount() {
            return rows;
        }

        @Override
        public int getColumnCount() {
            return cols;
        }

        @Override
        public String getColumnName(int c) {
            return Refs.indexToCol(c);
        }

        /** The displayed text (what copy and sorting see). Raw input comes from the Document. */
        @Override
        public Object getValueAt(int r, int c) {
            return doc.display(Refs.key(c, r));
        }

        @Override
        public boolean isCellEditable(int r, int c) {
            return true;
        }

        @Override
        public void setValueAt(Object v, int r, int c) {
            doc.setInput(Refs.key(c, r), v == null ? "" : v.toString());
        }
    }

    public SheetTable(Document doc) {
        this.doc = doc;
        this.model = new Model();
        setModel(model);
        setAutoResizeMode(AUTO_RESIZE_OFF);
        setCellSelectionEnabled(true);
        setSelectionMode(ListSelectionModel.MULTIPLE_INTERVAL_SELECTION);
        getTableHeader().setReorderingAllowed(false);
        setRowHeight(24);
        setGridColor(UIManager.getColor("Table.gridColor") != null ? UIManager.getColor("Table.gridColor") : new Color(0xe1e4e8));
        setShowGrid(true);
        setSurrendersFocusOnKeystroke(true);
        putClientProperty("terminateEditOnFocusLost", Boolean.TRUE);
        setDefaultRenderer(Object.class, new Renderer());

        JTextField field = new JTextField();
        field.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 13));
        setDefaultEditor(Object.class, new DefaultCellEditor(field) {
            @Override
            public Component getTableCellEditorComponent(JTable t, Object value, boolean sel, int r, int c) {
                Component comp = super.getTableCellEditorComponent(t, value, sel, r, c);
                // Typing starts a fresh value (like every spreadsheet); F2/double-click edits the raw input
                field.setText(editTrigger instanceof KeyEvent ? "" : doc.input(Refs.key(c, r)));
                return comp;
            }
        });
        applyWidths();
    }

    @Override
    public boolean editCellAt(int row, int column, EventObject e) {
        editTrigger = e;
        return super.editCellAt(row, column, e);
    }

    /** Re-sync structure and widths after a document change. */
    public void refresh() {
        // fireTableDataChanged/StructureChanged make JTable drop the selection, so avoid the
        // former and restore it after the latter.
        int oldRows = model.rows;
        int leadR = getSelectionModel().getLeadSelectionIndex(), anchorR = getSelectionModel().getAnchorSelectionIndex();
        int leadC = getColumnModel().getSelectionModel().getLeadSelectionIndex(), anchorC = getColumnModel().getSelectionModel().getAnchorSelectionIndex();
        if (model.fit()) {
            model.fireTableStructureChanged();
            if (anchorR >= 0 && anchorC >= 0) {
                changeSelection(anchorR, anchorC, false, false);
                changeSelection(leadR, leadC, false, true);
            }
        } else {
            if (model.rows > oldRows) model.fireTableRowsInserted(oldRows, model.rows - 1);
            model.fireTableRowsUpdated(0, model.rows - 1);
        }
        applyWidths();
    }

    void applyWidths() {
        for (int c = 0; c < getColumnModel().getColumnCount(); c++) {
            TableColumn col = getColumnModel().getColumn(c);
            int w = doc.wb.colWidths.getOrDefault(Refs.indexToCol(c), DEFAULT_WIDTH);
            if (col.getPreferredWidth() != w) col.setPreferredWidth(w);
        }
    }

    /** Selected rectangle (anchor..lead), or null. */
    public Refs.Range selection() {
        int[] rows = getSelectedRows();
        int[] cols = getSelectedColumns();
        if (rows.length == 0 || cols.length == 0) return null;
        return new Refs.Range(cols[0], rows[0], cols[cols.length - 1], rows[rows.length - 1]);
    }

    public String activeKey() {
        int r = Math.max(0, getSelectionModel().getLeadSelectionIndex());
        int c = Math.max(0, getColumnModel().getSelectionModel().getLeadSelectionIndex());
        return Refs.key(c, r);
    }

    private static Color hex(String s) {
        return s == null ? null : new Color(Integer.parseInt(s.substring(1), 16));
    }

    private final class Renderer extends DefaultTableCellRenderer {
        private final Border pyBorder = BorderFactory.createCompoundBorder(BorderFactory.createMatteBorder(0, 3, 0, 0, PY), BorderFactory.createEmptyBorder(0, 3, 0, 4));
        private final Border plain = BorderFactory.createEmptyBorder(0, 6, 0, 6);

        @Override
        public Component getTableCellRendererComponent(JTable t, Object value, boolean sel, boolean focus, int r, int c) {
            super.getTableCellRendererComponent(t, value, sel, focus, r, c);
            String k = Refs.key(c, r);
            Object v = doc.value(k);
            CellFormat f = doc.format(k);
            int style = (Boolean.TRUE.equals(f.bold()) ? Font.BOLD : 0) | (Boolean.TRUE.equals(f.italic()) ? Font.ITALIC : 0);
            setFont(t.getFont().deriveFont(style));
            int align = v instanceof Double ? SwingConstants.RIGHT : v instanceof Boolean || v instanceof GridError ? SwingConstants.CENTER : SwingConstants.LEFT;
            if (f.align() != null) align = switch (f.align()) {
                case "center" -> SwingConstants.CENTER;
                case "right" -> SwingConstants.RIGHT;
                default -> SwingConstants.LEFT;
            };
            setHorizontalAlignment(align);
            if (!sel) {
                Color bg = hex(f.bg());
                setBackground(bg != null ? bg : t.getBackground());
                Color fg = hex(f.color());
                if (fg == null && v instanceof GridError e) fg = e.code().equals("#BUSY!") ? BUSY : ERR;
                if (fg == null && bg != null) fg = luminance(bg) > 140 ? new Color(0x1d2127) : new Color(0xf5f6f8);
                setForeground(fg != null ? fg : t.getForeground());
            }
            setBorder(doc.isPython(k) ? pyBorder : plain);
            setToolTipText(v instanceof GridError e && !e.message().isEmpty() ? "<html><pre>" + escape(e.message()) + "</pre></html>" : null);
            return this;
        }
    }

    static double luminance(Color c) {
        return 0.2126 * c.getRed() + 0.7152 * c.getGreen() + 0.0722 * c.getBlue();
    }

    static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
