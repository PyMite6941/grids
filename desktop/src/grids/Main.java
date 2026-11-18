package grids;

import grids.ui.MainWindow;
import java.nio.file.Path;
import javax.swing.SwingUtilities;
import javax.swing.UIManager;

/** Grids desktop. Usage: java -jar grids.jar [workbook.grid] */
public final class Main {
    public static void main(String[] args) {
        System.setProperty("awt.useSystemAAFontSettings", "on");
        SwingUtilities.invokeLater(() -> {
            try {
                UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
            } catch (Exception ignored) {
                // default look and feel is fine
            }
            MainWindow w = new MainWindow();
            w.setVisible(true);
            if (args.length > 0) w.openPath(Path.of(args[0]));
        });
    }
}
