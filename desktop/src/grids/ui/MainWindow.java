package grids.ui;

import grids.app.Document;
import grids.engine.Format;
import grids.engine.Refs;
import grids.model.CellFormat;
import grids.model.Workbook;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.Toolkit;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.StringSelection;
import java.awt.event.ActionEvent;
import java.awt.event.InputEvent;
import java.awt.event.KeyEvent;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.swing.AbstractAction;
import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JFileChooser;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JSplitPane;
import javax.swing.JTextField;
import javax.swing.JToggleButton;
import javax.swing.JToolBar;
import javax.swing.KeyStroke;
import javax.swing.SwingUtilities;
import javax.swing.filechooser.FileNameExtensionFilter;

/** Main window: menus, toolbar, formula bar, grid, AI panel, Python banner, status bar. */
public final class MainWindow extends JFrame {
    private static final int MENU = Toolkit.getDefaultToolkit().getMenuShortcutKeyMaskEx();

    private final Document doc = new Document(SwingUtilities::invokeLater);
    private final SheetTable table = new SheetTable(doc);
    private final JLabel cellName = new JLabel("A1");
    private final JTextField formula = new JTextField();
    private final JLabel status = new JLabel(" ");
    private final JLabel pyStatus = new JLabel(" ");
    private final JPanel banner = new JPanel(new FlowLayout(FlowLayout.LEFT, 8, 4));
    private final JToggleButton boldBtn = new JToggleButton("B");
    private final JToggleButton italicBtn = new JToggleButton("I");
    private final JComboBox<String> numFmt = new JComboBox<>(Format.NUM_FORMATS.toArray(String[]::new));
    private final JSplitPane split;
    private final AiPanel ai;
    private boolean syncing = false;

    public MainWindow() {
        super("Grids");
        setIconImages(AppIcon.images());
        setDefaultCloseOperation(DO_NOTHING_ON_CLOSE);
        ai = new AiPanel(doc, () -> {
            Refs.Range r = table.selection();
            return r == null ? table.activeKey() : rangeText(r);
        });

        JPanel top = new JPanel(new BorderLayout());
        top.add(toolbar(), BorderLayout.NORTH);
        top.add(formulaBar(), BorderLayout.CENTER);
        banner.setBackground(new Color(0xfff4d6));
        banner.setBorder(BorderFactory.createMatteBorder(0, 0, 1, 0, new Color(0xe0c878)));
        JLabel warn = new JLabel("This workbook contains Python. Python on the desktop runs with full access to this computer, so it stays off for files you open.");
        warn.setForeground(new Color(0x5a4500));
        JButton enable = new JButton("Enable Python");
        enable.addActionListener(e -> doc.runAllPython());
        banner.add(warn);
        banner.add(enable);
        top.add(banner, BorderLayout.SOUTH);

        JScrollPane scroll = new JScrollPane(table);
        scroll.setRowHeaderView(new RowHeader(table));
        split = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, scroll, ai);
        split.setResizeWeight(1);

        JPanel bottom = new JPanel(new BorderLayout());
        bottom.setBorder(BorderFactory.createEmptyBorder(3, 8, 3, 8));
        bottom.add(status, BorderLayout.CENTER);
        bottom.add(pyStatus, BorderLayout.EAST);

        add(top, BorderLayout.NORTH);
        add(split, BorderLayout.CENTER);
        add(bottom, BorderLayout.SOUTH);
        setJMenuBar(menus());
        keys();

        table.getSelectionModel().addListSelectionListener(e -> syncSelection());
        table.getColumnModel().getSelectionModel().addListSelectionListener(e -> syncSelection());
        table.getColumnModel().addColumnModelListener(new WidthListener());
        doc.onChange = this::onDocChange;
        doc.onPyStatus = s -> pyStatus.setText(s.equals("ready") ? "" : "Python: " + s);

        addWindowListener(new WindowAdapter() {
            @Override
            public void windowClosing(WindowEvent e) {
                if (confirmDiscard()) {
                    doc.close();
                    dispose();
                    System.exit(0);
                }
            }
        });
        setSize(new Dimension(1280, 800));
        setLocationRelativeTo(null);
        SwingUtilities.invokeLater(() -> split.setDividerLocation(getWidth() - 380));
        table.changeSelection(0, 0, false, false);
        onDocChange();
    }

    // ---------- layout pieces ----------

    private JToolBar toolbar() {
        JToolBar bar = new JToolBar();
        bar.setFloatable(false);
        boldBtn.setFont(boldBtn.getFont().deriveFont(Font.BOLD));
        italicBtn.setFont(italicBtn.getFont().deriveFont(Font.ITALIC));
        for (JToggleButton b : new JToggleButton[] {boldBtn, italicBtn}) {
            b.setMargin(new java.awt.Insets(2, 8, 2, 8));
            b.setPreferredSize(new Dimension(32, 26));
            b.setMinimumSize(new Dimension(32, 26));
            b.setMaximumSize(new Dimension(32, 26));
        }
        boldBtn.setToolTipText("Bold (Ctrl+B)");
        italicBtn.setToolTipText("Italic (Ctrl+I)");
        boldBtn.addActionListener(e -> toggle("bold"));
        italicBtn.addActionListener(e -> toggle("italic"));
        bar.add(boldBtn);
        bar.add(italicBtn);
        bar.addSeparator();
        for (String a : new String[] {"left", "center", "right"}) {
            JButton b = new JButton(a.substring(0, 1).toUpperCase() + a.substring(1));
            b.addActionListener(e -> format(Map.of("align", a)));
            bar.add(b);
        }
        bar.addSeparator();
        numFmt.setMaximumSize(new Dimension(120, 28));
        numFmt.setToolTipText("Number format");
        numFmt.addActionListener(e -> {
            if (!syncing) format(Map.of("numFmt", (String) numFmt.getSelectedItem()));
        });
        bar.add(numFmt);
        bar.addSeparator();
        JButton fill = new JButton("Fill…");
        fill.addActionListener(e -> pickColor("bg"));
        JButton text = new JButton("Text colour…");
        text.addActionListener(e -> pickColor("color"));
        JButton clear = new JButton("Clear format");
        clear.addActionListener(e -> format(Map.of("bold", false, "italic", false, "align", "", "numFmt", "general", "bg", "", "color", "")));
        bar.add(fill);
        bar.add(text);
        bar.add(clear);
        bar.addSeparator();
        JButton runPy = new JButton("Run Python");
        runPy.setToolTipText("Re-run every Python cell (Ctrl+Shift+Enter)");
        runPy.addActionListener(e -> doc.runAllPython());
        bar.add(runPy);
        return bar;
    }

    private JPanel formulaBar() {
        JPanel p = new JPanel(new BorderLayout(8, 0));
        p.setBorder(BorderFactory.createEmptyBorder(4, 8, 4, 8));
        cellName.setPreferredSize(new Dimension(70, 24));
        cellName.setFont(new Font(Font.MONOSPACED, Font.BOLD, 13));
        formula.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 13));
        formula.setToolTipText("Enter a value, =FORMULA, or =py <python>. Shift+Enter in a Python cell is not needed here: use =py then ; or \\n.");
        formula.addActionListener(e -> {
            doc.setInput(table.activeKey(), formula.getText());
            table.requestFocusInWindow();
        });
        formula.getInputMap().put(KeyStroke.getKeyStroke(KeyEvent.VK_ESCAPE, 0), "cancel");
        formula.getActionMap().put("cancel", new AbstractAction() {
            @Override
            public void actionPerformed(ActionEvent e) {
                formula.setText(doc.input(table.activeKey()));
                table.requestFocusInWindow();
            }
        });
        JButton pyEdit = new JButton("Edit Python…");
        pyEdit.setToolTipText("Multi-line editor for the selected cell");
        pyEdit.addActionListener(e -> editMultiline());
        p.add(cellName, BorderLayout.WEST);
        p.add(formula, BorderLayout.CENTER);
        p.add(pyEdit, BorderLayout.EAST);
        return p;
    }

    private JMenuBar menus() {
        JMenuBar bar = new JMenuBar();
        JMenu file = new JMenu("File");
        file.add(item("New", KeyEvent.VK_N, e -> newFile()));
        file.add(item("Open…", KeyEvent.VK_O, e -> open()));
        file.add(item("Save", KeyEvent.VK_S, e -> save(false)));
        file.add(item("Save As…", 0, e -> save(true)));
        file.addSeparator();
        file.add(item("Import CSV…", 0, e -> importCsv()));
        file.add(item("Export CSV…", 0, e -> exportCsv()));
        file.addSeparator();
        file.add(item("Rename workbook…", 0, e -> {
            String t = JOptionPane.showInputDialog(this, "Workbook title", doc.wb.title);
            if (t != null && !t.isBlank()) doc.change(w -> w.title = t.strip());
        }));
        JMenu edit = new JMenu("Edit");
        edit.add(item("Undo", KeyEvent.VK_Z, e -> doc.undo()));
        edit.add(item("Redo", KeyEvent.VK_Y, e -> doc.redo()));
        edit.addSeparator();
        edit.add(item("Copy", KeyEvent.VK_C, e -> copy()));
        edit.add(item("Paste", KeyEvent.VK_V, e -> paste()));
        edit.add(item("Clear", 0, e -> clearSelection()));
        JMenu view = new JMenu("View");
        view.add(item("Toggle AI panel", 0, e -> {
            ai.setVisible(!ai.isVisible());
            if (ai.isVisible()) split.setDividerLocation(getWidth() - 380);
        }));
        bar.add(file);
        bar.add(edit);
        bar.add(view);
        return bar;
    }

    private JMenuItem item(String label, int key, java.awt.event.ActionListener l) {
        JMenuItem i = new JMenuItem(label);
        if (key != 0) i.setAccelerator(KeyStroke.getKeyStroke(key, MENU));
        i.addActionListener(l);
        return i;
    }

    /** Table-level shortcuts. JTable binds Ctrl+C/V itself, so ours replace those. */
    private void keys() {
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_DELETE, 0), "clear", this::clearSelection);
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_BACK_SPACE, 0), "clear", this::clearSelection);
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_C, MENU), "copy", this::copy);
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_V, MENU), "paste", this::paste);
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_B, MENU), "bold", () -> toggle("bold"));
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_I, MENU), "italic", () -> toggle("italic"));
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, MENU | InputEvent.SHIFT_DOWN_MASK), "runpy", doc::runAllPython);
    }

    private void bind(KeyStroke ks, String name, Runnable r) {
        table.getInputMap(JComponent.WHEN_ANCESTOR_OF_FOCUSED_COMPONENT).put(ks, name);
        table.getInputMap(JComponent.WHEN_FOCUSED).put(ks, name);
        table.getActionMap().put(name, new AbstractAction() {
            @Override
            public void actionPerformed(ActionEvent e) {
                r.run();
            }
        });
    }

    // ---------- sync ----------

    private void onDocChange() {
        if (table.isEditing()) table.getCellEditor().cancelCellEditing();
        table.refresh();
        setTitle("Grids — " + doc.wb.title + (doc.dirty ? " •" : "") + (doc.file != null ? " (" + doc.file.getFileName() + ")" : ""));
        banner.setVisible(doc.hasPython() && !doc.isTrusted());
        syncSelection();
    }

    private void syncSelection() {
        String k = table.activeKey();
        Refs.Range r = table.selection();
        cellName.setText(r != null && r.size() > 1 ? rangeText(r) : k);
        if (!formula.hasFocus()) formula.setText(doc.input(k));
        CellFormat f = doc.format(k);
        syncing = true;
        boldBtn.setSelected(Boolean.TRUE.equals(f.bold()));
        italicBtn.setSelected(Boolean.TRUE.equals(f.italic()));
        numFmt.setSelectedItem(f.numFmt() == null ? "general" : f.numFmt());
        syncing = false;

        Document.PyMeta meta = doc.pyMeta(k);
        Object v = doc.value(k);
        String spillFrom = doc.spills.get(k);
        if (v instanceof grids.engine.GridError e && !e.message().isEmpty()) status.setText(k + ": " + e.code() + " — " + firstLine(e.message()));
        else if (meta != null && meta.stdout() != null && !meta.stdout().isBlank()) status.setText(k + " printed: " + firstLine(meta.stdout()));
        else if (spillFrom != null && !spillFrom.equals(k)) status.setText(k + " is spilled from " + spillFrom);
        else if (r != null && r.size() > 1) status.setText(summary(r));
        else status.setText(" ");
    }

    private String summary(Refs.Range r) {
        double sum = 0;
        int count = 0, nums = 0;
        if (r.size() > 100_000) return "";
        for (int row = r.r1(); row <= r.r2(); row++)
            for (int c = r.c1(); c <= r.c2(); c++) {
                Object v = doc.value(Refs.key(c, row));
                if (v == null) continue;
                count++;
                if (v instanceof Double d) {
                    sum += d;
                    nums++;
                }
            }
        return nums == 0 ? "Count: " + count : "Sum: " + Format.general(sum) + "   Average: " + Format.general(sum / nums) + "   Count: " + count;
    }

    private static String firstLine(String s) {
        String[] lines = s.strip().split("\n");
        return lines[lines.length - 1];
    }

    private static String rangeText(Refs.Range r) {
        String a = Refs.key(r.c1(), r.r1()), b = Refs.key(r.c2(), r.r2());
        return a.equals(b) ? a : a + ":" + b;
    }

    private final class WidthListener implements javax.swing.event.TableColumnModelListener {
        @Override
        public void columnMarginChanged(javax.swing.event.ChangeEvent e) {
            // Persist user-dragged widths without making every pixel an undo step
            for (int c = 0; c < table.getColumnModel().getColumnCount(); c++) {
                int w = table.getColumnModel().getColumn(c).getWidth();
                String col = Refs.indexToCol(c);
                int cur = doc.wb.colWidths.getOrDefault(col, SheetTable.DEFAULT_WIDTH);
                if (w != cur && table.getTableHeader().getResizingColumn() != null) {
                    if (w == SheetTable.DEFAULT_WIDTH) doc.wb.colWidths.remove(col);
                    else doc.wb.colWidths.put(col, Math.max(40, Math.min(600, w)));
                    doc.dirty = true;
                }
            }
        }

        public void columnAdded(javax.swing.event.TableColumnModelEvent e) {}
        public void columnRemoved(javax.swing.event.TableColumnModelEvent e) {}
        public void columnMoved(javax.swing.event.TableColumnModelEvent e) {}
        public void columnSelectionChanged(javax.swing.event.ListSelectionEvent e) {}
    }

    // ---------- editing ----------

    private void toggle(String prop) {
        CellFormat f = doc.format(table.activeKey());
        boolean on = Boolean.TRUE.equals(prop.equals("bold") ? f.bold() : f.italic());
        format(Map.of(prop, !on));
    }

    private void format(Map<String, Object> patch) {
        Refs.Range r = table.selection();
        if (r != null) doc.formatRange(r, patch);
    }

    private void pickColor(String prop) {
        Color c = javax.swing.JColorChooser.showDialog(this, prop.equals("bg") ? "Fill colour" : "Text colour", Color.WHITE);
        if (c != null) format(Map.of(prop, String.format("#%02x%02x%02x", c.getRed(), c.getGreen(), c.getBlue())));
    }

    private void clearSelection() {
        Refs.Range r = table.selection();
        if (r == null || r.size() > Refs.MAX_RANGE_CELLS) return;
        doc.change(w -> {
            for (int row = r.r1(); row <= r.r2(); row++)
                for (int c = r.c1(); c <= r.c2(); c++) w.cells.remove(Refs.key(c, row));
        });
    }

    private void editMultiline() {
        String k = table.activeKey();
        String cur = doc.input(k);
        javax.swing.JTextArea area = new javax.swing.JTextArea(doc.isPython(k) ? grids.engine.Evaluator.pythonCode(cur) : cur, 16, 70);
        area.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 13));
        area.setTabSize(4);
        JPanel p = new JPanel(new BorderLayout(0, 6));
        p.add(new JLabel("Python for " + k + " — helpers: cell(\"A1\"), rng(\"A1:B5\"), vals(\"A1:A9\"), df(\"A1:C20\"). The last expression is the cell's value."), BorderLayout.NORTH);
        p.add(new JScrollPane(area), BorderLayout.CENTER);
        if (JOptionPane.showConfirmDialog(this, p, "Python cell " + k, JOptionPane.OK_CANCEL_OPTION, JOptionPane.PLAIN_MESSAGE) == JOptionPane.OK_OPTION) {
            String code = area.getText().stripTrailing();
            doc.setInput(k, code.isBlank() ? "" : "=py\n" + code);
        }
    }

    private void copy() {
        Refs.Range r = table.selection();
        if (r == null || r.size() > Refs.MAX_RANGE_CELLS) return;
        StringBuilder sb = new StringBuilder();
        for (int row = r.r1(); row <= r.r2(); row++) {
            if (row > r.r1()) sb.append('\n');
            for (int c = r.c1(); c <= r.c2(); c++) {
                if (c > r.c1()) sb.append('\t');
                // Single cell copies its input (so formulas survive); ranges copy displayed values
                String k = Refs.key(c, row);
                sb.append(r.size() == 1 ? doc.input(k) : doc.display(k));
            }
        }
        Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(sb.toString()), null);
    }

    private void paste() {
        String text;
        try {
            text = (String) Toolkit.getDefaultToolkit().getSystemClipboard().getData(DataFlavor.stringFlavor);
        } catch (Exception e) {
            return;
        }
        if (text == null || text.isEmpty()) return;
        String start = table.activeKey();
        Refs.Ref s = Refs.parseRef(start);
        String[] lines = text.replace("\r\n", "\n").replaceAll("\n$", "").split("\n", -1);
        if ((long) lines.length * 1 > Refs.MAX_ROWS) return;
        doc.change(w -> {
            for (int i = 0; i < lines.length; i++) {
                String[] parts = lines[i].split("\t", -1);
                for (int j = 0; j < parts.length; j++) {
                    int row = s.row() + i, col = s.col() + j;
                    if (row < Refs.MAX_ROWS && col < Refs.MAX_COLS) w.setInput(Refs.key(col, row), parts[j]);
                }
            }
        });
    }

    // ---------- files ----------

    private boolean confirmDiscard() {
        if (!doc.dirty) return true;
        int r = JOptionPane.showConfirmDialog(this, "Save changes to \"" + doc.wb.title + "\"?", "Grids", JOptionPane.YES_NO_CANCEL_OPTION);
        if (r == JOptionPane.YES_OPTION) return save(false);
        return r == JOptionPane.NO_OPTION;
    }

    private JFileChooser chooser(String ext, String label) {
        JFileChooser fc = new JFileChooser(doc.file != null ? doc.file.getParent().toFile() : null);
        fc.setFileFilter(new FileNameExtensionFilter(label, ext));
        return fc;
    }

    private void newFile() {
        if (confirmDiscard()) doc.replace(new Workbook(), null, true);
    }

    private void open() {
        if (!confirmDiscard()) return;
        JFileChooser fc = chooser("grid", "Grids workbook (*.grid)");
        if (fc.showOpenDialog(this) != JFileChooser.APPROVE_OPTION) return;
        openPath(fc.getSelectedFile().toPath());
    }

    /** Opened files are untrusted: Python stays off until the user enables it. */
    public void openPath(Path p) {
        try {
            String text = Files.readString(p, StandardCharsets.UTF_8);
            if (text.length() > 20_000_000) throw new IOException("File is larger than 20 MB.");
            doc.replace(Workbook.fromJson(text), p, false);
        } catch (IOException | IllegalArgumentException e) {
            JOptionPane.showMessageDialog(this, "Could not open " + p.getFileName() + ":\n" + e.getMessage(), "Grids", JOptionPane.ERROR_MESSAGE);
        }
    }

    private boolean save(boolean as) {
        Path target = doc.file;
        if (as || target == null) {
            JFileChooser fc = chooser("grid", "Grids workbook (*.grid)");
            fc.setSelectedFile(new java.io.File(safeName(doc.wb.title) + ".grid"));
            if (fc.showSaveDialog(this) != JFileChooser.APPROVE_OPTION) return false;
            target = fc.getSelectedFile().toPath();
            if (!target.getFileName().toString().toLowerCase().endsWith(".grid")) target = target.resolveSibling(target.getFileName() + ".grid");
        }
        try {
            Files.writeString(target, doc.wb.toJson(), StandardCharsets.UTF_8);
            doc.file = target;
            doc.dirty = false;
            onDocChange();
            return true;
        } catch (IOException e) {
            JOptionPane.showMessageDialog(this, "Could not save: " + e.getMessage(), "Grids", JOptionPane.ERROR_MESSAGE);
            return false;
        }
    }

    private void importCsv() {
        if (!confirmDiscard()) return;
        JFileChooser fc = chooser("csv", "CSV (*.csv)");
        if (fc.showOpenDialog(this) != JFileChooser.APPROVE_OPTION) return;
        Path p = fc.getSelectedFile().toPath();
        try {
            String name = p.getFileName().toString().replaceAll("(?i)\\.csv$", "");
            doc.replace(Workbook.fromCsv(name, Files.readString(p, StandardCharsets.UTF_8)), null, true);
            doc.dirty = true;
            onDocChange();
        } catch (IOException e) {
            JOptionPane.showMessageDialog(this, "Could not import: " + e.getMessage(), "Grids", JOptionPane.ERROR_MESSAGE);
        }
    }

    private void exportCsv() {
        int[] ext = doc.extent();
        List<List<String>> rows = new ArrayList<>();
        for (int r = 0; r <= ext[0]; r++) {
            List<String> row = new ArrayList<>();
            for (int c = 0; c <= ext[1]; c++) row.add(doc.display(Refs.key(c, r)));
            rows.add(row);
        }
        JFileChooser fc = chooser("csv", "CSV (*.csv)");
        fc.setSelectedFile(new java.io.File(safeName(doc.wb.title) + ".csv"));
        if (fc.showSaveDialog(this) != JFileChooser.APPROVE_OPTION) return;
        try {
            Files.writeString(fc.getSelectedFile().toPath(), Workbook.toCsv(rows), StandardCharsets.UTF_8);
        } catch (IOException e) {
            JOptionPane.showMessageDialog(this, "Could not export: " + e.getMessage(), "Grids", JOptionPane.ERROR_MESSAGE);
        }
    }

    static String safeName(String s) {
        String n = s.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").strip();
        return n.isEmpty() ? "workbook" : n.substring(0, Math.min(80, n.length()));
    }
}
