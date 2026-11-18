package grids.ui;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.RenderingHints;
import java.awt.geom.Path2D;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.List;

/**
 * The Grids icon, drawn in code so it is sharp at every size: green tile, white sheet
 * grid, yellow AI sparkle. Same design as web/public/favicon.svg (32-unit viewBox).
 */
public final class AppIcon {
    private AppIcon() {}

    static final Color GREEN = new Color(0x1a7f5a);
    static final Color SPARK = new Color(0xffd166);

    /** Sizes the OS picks from: title bar, taskbar, Alt-Tab, dock. */
    public static List<Image> images() {
        List<Image> out = new ArrayList<>();
        for (int s : new int[] {16, 20, 24, 32, 40, 48, 64, 128, 256}) out.add(render(s));
        return out;
    }

    public static BufferedImage render(int size) {
        BufferedImage img = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = img.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
        double u = size / 32.0;
        g.scale(u, u);

        g.setColor(GREEN);
        g.fill(new RoundRectangle2D.Double(0, 0, 32, 32, 14, 14));

        // Small sizes get slightly thicker lines so the grid doesn't blur away
        float w = size <= 20 ? 2.4f : 2f;
        g.setColor(Color.WHITE);
        g.setStroke(new BasicStroke(w, BasicStroke.CAP_BUTT, BasicStroke.JOIN_ROUND));
        g.draw(new RoundRectangle2D.Double(6.5, 6.5, 18, 18, 4, 4));
        Path2D.Double lines = new Path2D.Double();
        lines.moveTo(6.5, 12.5);
        lines.lineTo(24.5, 12.5);
        lines.moveTo(6.5, 18.5);
        lines.lineTo(24.5, 18.5);
        lines.moveTo(12.5, 6.5);
        lines.lineTo(12.5, 24.5);
        g.draw(lines);

        // Four-point sparkle centred at (23, 23), outlined in the tile colour to sit on the grid
        Path2D.Double star = new Path2D.Double();
        star.moveTo(23, 16);
        star.quadTo(23.8, 22.2, 30, 23);
        star.quadTo(23.8, 23.8, 23, 30);
        star.quadTo(22.2, 23.8, 16, 23);
        star.quadTo(22.2, 22.2, 23, 16);
        star.closePath();
        g.setColor(GREEN);
        g.setStroke(new BasicStroke(1.6f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        g.draw(star);
        g.setColor(SPARK);
        g.fill(star);
        g.dispose();
        return img;
    }
}
