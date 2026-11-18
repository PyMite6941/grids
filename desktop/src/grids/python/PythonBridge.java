package grids.python;

import grids.json.Json;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Runs "=py" cells in a real local CPython process using shared/python/grid_runtime.py
 * (bundled into the jar). One long-lived process, newline-delimited JSON over stdin/stdout.
 *
 * Unlike the website (Pyodide in a browser sandbox) this is full Python with access to the
 * machine, which is why Document only runs cells for trusted workbooks.
 *
 * Interpreter: $GRIDS_PYTHON, else "python" on Windows / "python3" elsewhere.
 * Not thread-safe: call run() from one worker thread.
 */
public final class PythonBridge implements AutoCloseable {
    private static final long FIRST_RUN_TIMEOUT_S = 60; // first pandas import can be slow
    private static final long RUN_TIMEOUT_S = 15;

    /** value is a JSON-ish Object (see Evaluator.fromPlain). */
    public record Result(Object value, String stdout, List<String> reads, String error) {
        static Result failure(String message) {
            return new Result(Map.of("error", "#PYTHON!", "message", message), "", List.of(), message);
        }
    }

    private Process process;
    private BufferedWriter stdin;
    private final BlockingQueue<String> lines = new LinkedBlockingQueue<>();
    private final StringBuilder stderr = new StringBuilder();
    private boolean warm = false;
    private int nextId = 1;

    public static String interpreter() {
        String env = System.getenv("GRIDS_PYTHON");
        if (env != null && !env.isBlank()) return env;
        return System.getProperty("os.name", "").toLowerCase().contains("win") ? "python" : "python3";
    }

    private void start() throws IOException {
        Path script = Files.createTempFile("grids_runtime_", ".py");
        script.toFile().deleteOnExit();
        try (InputStream in = PythonBridge.class.getResourceAsStream("/grids/shared/python/grid_runtime.py")) {
            if (in == null) throw new IOException("grid_runtime.py is missing from the build");
            Files.copy(in, script, StandardCopyOption.REPLACE_EXISTING);
        }
        // -I: isolated mode (ignores PYTHON* env vars and the user site dir); -u: unbuffered
        ProcessBuilder pb = new ProcessBuilder(interpreter(), "-I", "-u", script.toString());
        pb.environment().put("PYTHONIOENCODING", "utf-8");
        process = pb.start();
        stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
        lines.clear();
        warm = false;
        Process p = process;
        Thread out = new Thread(() -> pump(p.getInputStream(), true), "python-stdout");
        Thread err = new Thread(() -> pump(p.getErrorStream(), false), "python-stderr");
        out.setDaemon(true);
        err.setDaemon(true);
        out.start();
        err.start();
    }

    private void pump(InputStream in, boolean isOut) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                if (isOut) lines.add(line);
                else synchronized (stderr) {
                    stderr.append(line).append('\n');
                    if (stderr.length() > 4000) stderr.delete(0, stderr.length() - 4000);
                }
            }
        } catch (IOException ignored) {
            // process died; run() reports it
        }
    }

    @SuppressWarnings("unchecked")
    public Result run(String code, Map<String, Object> values) {
        try {
            if (process == null || !process.isAlive()) start();
        } catch (IOException e) {
            return Result.failure("Could not start Python (" + interpreter() + "): " + e.getMessage()
                    + ". Install Python 3 or set GRIDS_PYTHON to its path.");
        }
        int id = nextId++;
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("id", id);
        req.put("code", code);
        req.put("values", values);
        try {
            stdin.write(Json.write(req));
            stdin.write('\n');
            stdin.flush();
            long timeout = warm ? RUN_TIMEOUT_S : FIRST_RUN_TIMEOUT_S;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeout);
            while (true) {
                long left = deadline - System.nanoTime();
                String line = left > 0 ? lines.poll(left, TimeUnit.NANOSECONDS) : null;
                if (line == null) {
                    // Stuck cell (while True: ...) or dead interpreter: kill it, next run restarts
                    boolean dead = !process.isAlive();
                    close();
                    return Result.failure(dead ? "Python exited: " + lastStderr() : "Timed out after " + timeout + "s");
                }
                Object parsed;
                try {
                    parsed = Json.parse(line);
                } catch (IllegalArgumentException e) {
                    continue; // not a protocol line
                }
                if (!(parsed instanceof Map<?, ?> m) || !(m.get("id") instanceof Double rid) || rid.intValue() != id) continue;
                warm = true;
                List<String> reads = new ArrayList<>();
                if (m.get("reads") instanceof List<?> l) for (Object o : l) reads.add(String.valueOf(o));
                return new Result(m.get("value"), m.get("stdout") instanceof String s ? s : "", reads, m.get("error") instanceof String s ? s : null);
            }
        } catch (IOException e) {
            close();
            return Result.failure("Python connection lost: " + e.getMessage() + " " + lastStderr());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Result.failure("Interrupted");
        }
    }

    private String lastStderr() {
        synchronized (stderr) {
            String s = stderr.toString().strip();
            return s.length() > 500 ? s.substring(s.length() - 500) : s;
        }
    }

    @Override
    public void close() {
        if (process != null) {
            process.descendants().forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
            process = null;
        }
    }
}
