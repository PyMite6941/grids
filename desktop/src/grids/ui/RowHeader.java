package grids.ui;

import java.awt.Component;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JTable;
import javax.swing.ListCellRenderer;
import javax.swing.SwingConstants;
import javax.swing.UIManager;
import javax.swing.AbstractListModel;
import javax.swing.event.TableModelEvent;

/** Row numbers down the left edge, kept in sync with the table's row count. */
final class RowHeader extends JList<String> {
    RowHeader(JTable table) {
        AbstractListModel<String> model = new AbstractListModel<>() {
            @Override
            public int getSize() {
                return table.getRowCount();
            }

            @Override
            public String getElementAt(int i) {
                return Integer.toString(i + 1);
            }
        };
        setModel(model);
        setFixedCellWidth(48);
        setFixedCellHeight(table.getRowHeight());
        setFocusable(false);
        setBackground(UIManager.getColor("TableHeader.background"));
        JLabel proto = new JLabel();
        setCellRenderer((ListCellRenderer<String>) (list, value, index, sel, focus) -> {
            proto.setText(value);
            proto.setHorizontalAlignment(SwingConstants.CENTER);
            proto.setFont(table.getTableHeader().getFont());
            proto.setBorder(UIManager.getBorder("TableHeader.cellBorder"));
            return (Component) proto;
        });
        table.getModel().addTableModelListener(e -> {
            if (e.getType() != TableModelEvent.UPDATE || e.getFirstRow() == TableModelEvent.HEADER_ROW || e.getLastRow() == Integer.MAX_VALUE) {
                revalidate();
                repaint();
            }
        });
    }
}
