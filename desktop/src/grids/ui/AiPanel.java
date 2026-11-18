package grids.ui;

import grids.ai.AiClient;
import grids.ai.KeyRing;
import grids.ai.Subscriptions;
import grids.app.Document;
import grids.engine.Evaluator;
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.GridLayout;
import java.awt.Window;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import java.util.prefs.Preferences;
import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JPasswordField;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.SwingUtilities;
import javax.swing.SwingWorker;

/**
 * AI side panel. Proposed changes are shown first and applied on "Apply" (one undo step).
 * Auto-apply never covers changes that write Python cells — on desktop those run with full
 * access to this machine, so a human always looks first.
 *
 * Connections (API keys and subscriptions) live in the local .env via KeyRing; the header
 * picker chooses one or "Auto", and the Keys dialog adds/removes them and shows usage.
 */
public final class AiPanel extends JPanel {
    private static final Preferences PREFS = Preferences.userNodeForPackage(AiPanel.class);

    private final Document doc;
    private final Supplier<String> selection;
    private final AiClient client = new AiClient();
    private final KeyRing ring = new KeyRing();
    private final List<AiClient.Message> history = new ArrayList<>();
    private final JPanel log = new JPanel();
    private final JScrollPane logScroll;
    private final JTextArea input = new JTextArea(3, 20);
    private final JButton send = new JButton("Send");
    private final JCheckBox auto = new JCheckBox("Auto-apply (not Python)");
    private final JComboBox<String> connection = new JComboBox<>();
    private final List<String> connectionNames = new ArrayList<>(); // parallel to the combo's items
    private boolean filling;

    public AiPanel(Document doc, Supplier<String> selection) {
        super(new BorderLayout());
        this.doc = doc;
        this.selection = selection;
        setPreferredSize(new Dimension(360, 400));
        setBorder(BorderFactory.createMatteBorder(0, 1, 0, 0, getBackground().darker()));

        JPanel head = new JPanel(new BorderLayout(8, 0));
        head.setBorder(BorderFactory.createEmptyBorder(6, 10, 6, 6));
        JLabel title = new JLabel("AI");
        title.setFont(title.getFont().deriveFont(Font.BOLD));
        head.add(title, BorderLayout.WEST);
        connection.setFont(connection.getFont().deriveFont(11f));
        connection.setToolTipText("Which key or subscription to use");
        connection.setPrototypeDisplayValue("Auto — 2 of 3 ready");
        connection.addActionListener(e -> {
            int i = connection.getSelectedIndex();
            if (!filling && i >= 0 && i < connectionNames.size()) PREFS.put("connection", connectionNames.get(i));
        });
        head.add(connection, BorderLayout.CENTER);
        JButton keys = new JButton("Keys");
        keys.setToolTipText("AI keys & subscriptions");
        keys.addActionListener(e -> openKeys());
        head.add(keys, BorderLayout.EAST);
        add(head, BorderLayout.NORTH);

        log.setLayout(new BoxLayout(log, BoxLayout.Y_AXIS));
        log.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
        JPanel logWrap = new JPanel(new BorderLayout());
        logWrap.add(log, BorderLayout.NORTH);
        logScroll = new JScrollPane(logWrap);
        logScroll.getVerticalScrollBar().setUnitIncrement(16);
        add(logScroll, BorderLayout.CENTER);

        input.setLineWrap(true);
        input.setWrapStyleWord(true);
        input.addKeyListener(new KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == KeyEvent.VK_ENTER && !e.isShiftDown()) {
                    e.consume();
                    send();
                }
            }
        });
        send.addActionListener(e -> send());
        JPanel form = new JPanel(new BorderLayout(0, 4));
        form.setBorder(BorderFactory.createEmptyBorder(6, 8, 8, 8));
        form.add(new JScrollPane(input), BorderLayout.CENTER);
        JPanel row = new JPanel(new BorderLayout());
        row.add(auto, BorderLayout.WEST);
        row.add(send, BorderLayout.EAST);
        form.add(row, BorderLayout.SOUTH);
        add(form, BorderLayout.SOUTH);

        note("Ask for anything: \"make a monthly budget with totals\", \"add a column with each row's share of the total\", \"use Python to fit a trend line to B2:B20\".");
        refreshConnections();
    }

    /** "12/100 today" or "12 today", plus why it can't be used right now. */
    static String usageText(KeyRing.View k) {
        String used = k.limit() > 0 ? k.requests() + "/" + k.limit() + " today" : k.requests() + " today";
        if (Boolean.FALSE.equals(k.installed())) return used + " · CLI not installed";
        if (k.coolingFor() > 0) return used + " · paused " + (k.coolingFor() >= 120 ? (k.coolingFor() + 59) / 60 + "m" : k.coolingFor() + "s");
        if (k.limit() > 0 && k.requests() >= k.limit()) return used + " · limit reached";
        return used;
    }

    private void refreshConnections() {
        List<KeyRing.View> views = ring.summary();
        filling = true;
        connection.removeAllItems();
        connectionNames.clear();
        if (views.isEmpty()) {
            connection.addItem("No AI connected — click Keys");
            connectionNames.add("auto");
        } else {
            long ready = views.stream().filter(KeyRing.View::available).count();
            connection.addItem("Auto — " + ready + " of " + views.size() + " ready");
            connectionNames.add("auto");
            for (KeyRing.View v : views) {
                String what = "sub".equals(v.type()) ? v.label().replaceAll(" \\(.*\\)$", "") : v.model();
                connection.addItem(v.name() + " · " + what + " · " + usageText(v));
                connectionNames.add(v.name());
            }
        }
        String want = PREFS.get("connection", ring.defaultSelection());
        int i = connectionNames.indexOf(want);
        connection.setSelectedIndex(Math.max(0, i));
        filling = false;
    }

    private String chosenConnection() {
        int i = connection.getSelectedIndex();
        return i >= 0 && i < connectionNames.size() ? connectionNames.get(i) : "auto";
    }

    private JTextArea bubble(String text) {
        JTextArea t = new JTextArea(text);
        t.setEditable(false);
        t.setLineWrap(true);
        t.setWrapStyleWord(true);
        t.setFont(javax.swing.UIManager.getFont("Label.font")); // JTextArea defaults to monospace
        t.setBorder(BorderFactory.createEmptyBorder(6, 8, 6, 8));
        t.setAlignmentX(Component.LEFT_ALIGNMENT);
        return t;
    }

    private Component post(Component c, String role) {
        JPanel wrap = new JPanel(new BorderLayout());
        wrap.setAlignmentX(Component.LEFT_ALIGNMENT);
        wrap.setBorder(BorderFactory.createTitledBorder(role));
        wrap.add(c, BorderLayout.CENTER);
        log.add(wrap);
        log.add(Box.createVerticalStrut(6));
        log.revalidate();
        SwingUtilities.invokeLater(() -> logScroll.getVerticalScrollBar().setValue(logScroll.getVerticalScrollBar().getMaximum()));
        return wrap;
    }

    private void note(String text) {
        JTextArea t = bubble(text);
        t.setFont(t.getFont().deriveFont(Font.ITALIC));
        log.add(t);
        log.add(Box.createVerticalStrut(6));
    }

    private void send() {
        String text = input.getText().strip();
        if (text.isEmpty() || !send.isEnabled()) return;
        input.setText("");
        post(bubble(text), "You");
        history.add(new AiClient.Message("user", text));
        send.setEnabled(false);
        Component pending = post(bubble("Thinking…"), "AI");
        String chosen = chosenConnection();
        String context = AiClient.describeSheet(doc.wb.title, selection.get(), doc.aiSnapshot());
        List<AiClient.Message> snapshot = List.copyOf(history);
        new SwingWorker<AiClient.Reply, Void>() {
            @Override
            protected AiClient.Reply doInBackground() throws Exception {
                return client.ask(ring, chosen, snapshot, context);
            }

            @Override
            protected void done() {
                log.remove(pending);
                send.setEnabled(true);
                try {
                    showReply(get());
                } catch (Exception e) {
                    history.remove(history.size() - 1);
                    Throwable cause = e.getCause() != null ? e.getCause() : e;
                    JTextArea err = bubble(cause.getMessage());
                    err.setForeground(SheetTable.ERR);
                    post(err, "Error");
                }
                refreshConnections(); // usage counts changed
            }
        }.execute();
    }

    private static boolean writesPython(List<AiClient.Action> actions) {
        for (AiClient.Action a : actions) {
            if (a.name().equals("set_cells") && a.args().get("cells") instanceof List<?> cells) {
                for (Object c : cells) if (c instanceof Map<?, ?> m && m.get("input") instanceof String s && Evaluator.isPythonInput(s)) return true;
            }
        }
        return false;
    }

    static String describe(AiClient.Action a) {
        Map<String, Object> args = a.args();
        return switch (a.name()) {
            case "set_cells" -> {
                StringBuilder sb = new StringBuilder();
                if (args.get("cells") instanceof List<?> cells) {
                    int n = 0;
                    for (Object c : cells) {
                        if (n++ == 8) {
                            sb.append("• … and ").append(cells.size() - 8).append(" more\n");
                            break;
                        }
                        if (c instanceof Map<?, ?> m) {
                            String in = String.valueOf(m.get("input"));
                            sb.append("• ").append(m.get("ref")).append(" ← ")
                                    .append(Evaluator.isPythonInput(in) ? "[Python] " : "")
                                    .append(in.length() > 60 ? in.substring(0, 60) + "…" : in.isEmpty() ? "(clear)" : in).append('\n');
                        }
                    }
                }
                yield sb.toString();
            }
            case "clear_range" -> "• Clear " + args.get("range") + "\n";
            case "format_range" -> "• Format " + args.get("range") + " — " + args.entrySet().stream().filter(e -> !e.getKey().equals("range"))
                    .map(e -> e.getKey() + ": " + e.getValue()).reduce((x, y) -> x + ", " + y).orElse("") + "\n";
            case "set_column_width" -> "• Column " + args.get("column") + " width → " + args.get("width") + "px\n";
            case "set_title" -> "• Rename workbook to \"" + args.get("title") + "\"\n";
            default -> "• " + a.name() + "\n";
        };
    }

    private void showReply(AiClient.Reply reply) {
        int idx = history.size();
        history.add(new AiClient.Message("assistant", reply.text()));
        JPanel box = new JPanel();
        box.setLayout(new BoxLayout(box, BoxLayout.Y_AXIS));
        box.add(bubble(reply.text()));
        if (reply.actions().isEmpty()) {
            post(box, reply.key() != null ? "AI · " + reply.key() + " · " + reply.model() : "AI");
            return;
        }
        StringBuilder sb = new StringBuilder();
        for (AiClient.Action a : reply.actions()) sb.append(describe(a));
        JTextArea list = bubble(sb.toString().stripTrailing());
        list.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        box.add(list);
        JPanel buttons = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 2));
        buttons.setAlignmentX(Component.LEFT_ALIGNMENT);
        JButton apply = new JButton("Apply");
        JButton discard = new JButton("Discard");
        JLabel status = new JLabel();
        buttons.add(apply);
        buttons.add(discard);
        buttons.add(status);
        box.add(buttons);
        Runnable finish = () -> {
            apply.setEnabled(false);
            discard.setEnabled(false);
        };
        apply.addActionListener(e -> {
            List<String> problems = doc.applyActions(reply.actions());
            finish.run();
            history.set(idx, new AiClient.Message("assistant", reply.text() + "\n[Proposed changes were applied]"));
            status.setText(problems.isEmpty() ? "Applied — Ctrl+Z to undo." : "Applied; skipped: " + String.join("; ", problems));
        });
        discard.addActionListener(e -> {
            finish.run();
            history.set(idx, new AiClient.Message("assistant", reply.text() + "\n[Proposed changes were discarded by the user]"));
            status.setText("Discarded.");
        });
        if (auto.isSelected() && !writesPython(reply.actions())) apply.doClick();
        else if (auto.isSelected()) status.setText("Contains Python — review first.");
        post(box, reply.key() != null ? "AI · " + reply.key() + " · " + reply.model() : "AI");
    }

    // ---------- Keys dialog ----------

    private void openKeys() {
        Window owner = SwingUtilities.getWindowAncestor(this);
        JDialog d = new JDialog(owner, "AI keys & subscriptions", java.awt.Dialog.ModalityType.APPLICATION_MODAL);
        JPanel list = new JPanel();
        list.setLayout(new BoxLayout(list, BoxLayout.Y_AXIS));
        JLabel msg = new JLabel(" ");

        Runnable[] render = new Runnable[1];
        render[0] = () -> {
            list.removeAll();
            List<KeyRing.View> views = ring.summary();
            if (views.isEmpty()) list.add(left(new JLabel("Nothing connected yet — add a subscription or an API key below.")));
            for (KeyRing.View v : views) {
                JPanel row = new JPanel(new BorderLayout(8, 0));
                row.setAlignmentX(Component.LEFT_ALIGNMENT);
                row.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createMatteBorder(0, 0, 1, 0, getBackground().darker()),
                        BorderFactory.createEmptyBorder(6, 2, 6, 2)));
                boolean sub = "sub".equals(v.type());
                String html = "<html><div style='width:" + TEXT_W_ROW + "px'><b>" + SheetTable.escape(v.name()) + "</b> &nbsp;<span style='color:gray'>" + (sub ? "subscription" : "API key") + "</span><br>"
                        + SheetTable.escape((sub ? v.label() : v.label() + " · " + v.hint()) + " · " + v.model()) + "<br>"
                        + SheetTable.escape(usageText(v) + " · " + v.tokens() + " tokens" + (v.rateLimited() > 0 ? " · " + v.rateLimited() + "× rate-limited" : ""))
                        + (v.lastError().isEmpty() ? "" : "<br><span style='color:#b3261e'>" + SheetTable.escape(v.lastError().length() > 140 ? v.lastError().substring(0, 140) + "…" : v.lastError()) + "</span>")
                        + "</div></html>";
                JLabel text = new JLabel(html);
                if (!v.available()) text.setForeground(java.awt.Color.GRAY.darker());
                row.add(text, BorderLayout.CENTER);
                if (!"LOCAL".equals(v.name())) {
                    JButton rm = new JButton("Remove");
                    rm.addActionListener(e -> edit(msg, render[0], () -> {
                        ring.removeKey(v.name());
                        return "Removed " + v.name() + ".";
                    }));
                    JPanel holder = new JPanel(new FlowLayout(FlowLayout.RIGHT, 0, 0));
                    holder.add(rm);
                    row.add(holder, BorderLayout.EAST);
                }
                row.setMaximumSize(new Dimension(Integer.MAX_VALUE, row.getPreferredSize().height));
                list.add(row);
            }
            list.revalidate();
            list.repaint();
        };
        render[0].run();

        // Add a subscription
        List<String> kinds = new ArrayList<>(Subscriptions.KINDS.keySet());
        JComboBox<String> kind = new JComboBox<>();
        for (String k : kinds) {
            Subscriptions.Kind sk = Subscriptions.KINDS.get(k);
            kind.addItem(sk.label() + (Subscriptions.detect(sk.bin()) == null ? " — not installed" : ""));
        }
        JLabel subHint = new JLabel();
        Runnable hint = () -> {
            Subscriptions.Kind sk = Subscriptions.KINDS.get(kinds.get(Math.max(0, kind.getSelectedIndex())));
            subHint.setText("<html><div style='width:" + TEXT_W + "px; color:gray'>" + SheetTable.escape(Subscriptions.detect(sk.bin()) != null
                    ? "CLI found. " + sk.login() : "CLI not found on this computer. Install it, then: " + sk.login()) + "</div></html>");
        };
        kind.addActionListener(e -> hint.run());
        hint.run();
        JTextField subName = new JTextField(10);
        JTextField subLimit = new JTextField(6);
        JTextField subModel = new JTextField(14);
        subModel.setToolTipText("Leave empty for the CLI default (e.g. sonnet, haiku, gpt-5, gemini-2.5-pro)");
        JButton addSub = new JButton("Add subscription");
        addSub.addActionListener(e -> edit(msg, render[0], () -> {
            String k = kinds.get(Math.max(0, kind.getSelectedIndex()));
            String n = ring.addSubscription(subName.getText().isBlank() ? k : subName.getText(), k, subLimit.getText(), subModel.getText());
            subName.setText("");
            subLimit.setText("");
            subModel.setText("");
            return "Saved " + n + ".";
        }));
        JPanel subForm = section("Add a subscription",
                "Use a plan you already pay for. Grids runs the vendor's own CLI on this computer, signed in with your account. No key is stored.",
                labelled("Subscription", kind), subHint,
                grid(labelled("Name", subName), labelled("Daily request limit", subLimit), labelled("Model", subModel)),
                right(addSub));

        // Add an API key
        JTextField keyName = new JTextField(10);
        JPasswordField keyValue = new JPasswordField(24);
        JTextField keyLimit = new JTextField(6);
        JTextField keyBase = new JTextField(20);
        keyBase.setToolTipText("Empty = AI_BASE_URL or Groq. For Ollama: http://localhost:11434/v1");
        JTextField keyModel = new JTextField(14);
        JButton addKey = new JButton("Add key");
        addKey.addActionListener(e -> edit(msg, render[0], () -> {
            String n = ring.addKey(keyName.getText(), new String(keyValue.getPassword()), keyLimit.getText(), keyBase.getText(), keyModel.getText());
            for (JTextField f : List.of(keyName, keyValue, keyLimit, keyBase, keyModel)) f.setText("");
            return "Saved " + n + ".";
        }));
        JPanel keyForm = section("Add an API key",
                "Any OpenAI-compatible provider: Groq, OpenRouter, OpenAI, Gemini, Together, DeepSeek, Ollama…",
                grid(labelled("Name", keyName), labelled("Daily request limit", keyLimit)),
                labelled("API key", keyValue),
                grid(labelled("Base URL", keyBase), labelled("Model", keyModel)),
                right(addKey));

        JPanel body = new WidthTracking();
        body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS));
        body.setBorder(BorderFactory.createEmptyBorder(12, 14, 12, 14));
        body.add(left(new JLabel("<html><div style='width:" + TEXT_W + "px; color:gray'>Pick one in the AI panel, or choose Auto: it uses whichever has the most of its "
                + "daily limit left and switches when one is rate-limited or used up.<br>Saved in " + SheetTable.escape(ring.path.toString())
                + " — local only, never commit it.</div></html>")));
        body.add(Box.createVerticalStrut(8));
        body.add(list);
        body.add(left(msg));
        body.add(subForm);
        body.add(keyForm);
        JButton close = new JButton("Close");
        close.addActionListener(e -> d.dispose());
        body.add(right(close));

        JScrollPane scroll = new JScrollPane(body);
        scroll.setBorder(null);
        scroll.getVerticalScrollBar().setUnitIncrement(16);
        d.setContentPane(scroll);
        d.setSize(560, 640);
        d.setLocationRelativeTo(owner);
        d.setVisible(true); // modal
        refreshConnections();
    }

    /** Swing HTML only wraps at a set width; these fit the 560px dialog (rows leave room for Remove). */
    private static final int TEXT_W = 410;
    private static final int TEXT_W_ROW = 370;

    /** Panel that is always as wide as its scroll pane, so rows shrink instead of scrolling sideways. */
    private static final class WidthTracking extends JPanel implements javax.swing.Scrollable {
        @Override
        public Dimension getPreferredScrollableViewportSize() {
            return getPreferredSize();
        }

        @Override
        public int getScrollableUnitIncrement(java.awt.Rectangle r, int orientation, int direction) {
            return 16;
        }

        @Override
        public int getScrollableBlockIncrement(java.awt.Rectangle r, int orientation, int direction) {
            return r.height - 32;
        }

        @Override
        public boolean getScrollableTracksViewportWidth() {
            return true;
        }

        @Override
        public boolean getScrollableTracksViewportHeight() {
            return false;
        }
    }

    private interface Edit {
        String run();
    }

    private void edit(JLabel msg, Runnable render, Edit e) {
        try {
            msg.setForeground(javax.swing.UIManager.getColor("Label.foreground"));
            msg.setText(e.run());
        } catch (KeyRing.KeyException ex) {
            msg.setForeground(SheetTable.ERR);
            msg.setText(ex.getMessage());
        }
        render.run();
        refreshConnections();
    }

    private static <T extends JComponent> T left(T c) {
        c.setAlignmentX(Component.LEFT_ALIGNMENT);
        return c;
    }

    private static JPanel right(JComponent c) {
        JPanel p = new JPanel(new FlowLayout(FlowLayout.RIGHT, 0, 4));
        p.add(c);
        p.setAlignmentX(Component.LEFT_ALIGNMENT);
        p.setMaximumSize(new Dimension(Integer.MAX_VALUE, p.getPreferredSize().height));
        return p;
    }

    private static JPanel labelled(String label, JComponent field) {
        JPanel p = new JPanel(new BorderLayout(0, 2));
        p.add(new JLabel(label), BorderLayout.NORTH);
        p.add(field, BorderLayout.CENTER);
        p.setAlignmentX(Component.LEFT_ALIGNMENT);
        p.setMaximumSize(new Dimension(Integer.MAX_VALUE, p.getPreferredSize().height));
        return p;
    }

    private static JPanel grid(JComponent... cells) {
        JPanel p = new JPanel(new GridLayout(1, cells.length, 10, 0));
        for (JComponent c : cells) p.add(c);
        p.setAlignmentX(Component.LEFT_ALIGNMENT);
        p.setMaximumSize(new Dimension(Integer.MAX_VALUE, p.getPreferredSize().height));
        return p;
    }

    private static JPanel section(String title, String blurb, JComponent... rows) {
        JPanel p = new JPanel();
        p.setLayout(new BoxLayout(p, BoxLayout.Y_AXIS));
        p.setAlignmentX(Component.LEFT_ALIGNMENT);
        p.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createMatteBorder(1, 0, 0, 0, java.awt.Color.LIGHT_GRAY),
                BorderFactory.createEmptyBorder(10, 0, 4, 0)));
        JLabel t = new JLabel(title);
        t.setFont(t.getFont().deriveFont(Font.BOLD));
        p.add(left(t));
        p.add(left(new JLabel("<html><div style='width:" + TEXT_W + "px; color:gray'>" + SheetTable.escape(blurb) + "</div></html>")));
        for (JComponent r : rows) {
            p.add(Box.createVerticalStrut(6));
            p.add(left(r));
        }
        return p;
    }
}
