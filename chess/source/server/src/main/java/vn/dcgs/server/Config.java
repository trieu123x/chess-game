package vn.dcgs.server;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/**
 * Doc config.properties.
 *
 * Moi kich ban thuc nghiem (E2 nio/blocking, E3 binary/json, E4 bu dong ho,
 * E7 rules remote/embedded) deu doi bang file nay chu khong sua code - dieu
 * kien de ket qua tai lap duoc theo EXPERIMENTS.md.
 *
 * Bien moi truong ghi de duoc gia tri trong file, dung ten viet hoa va thay
 * dau cham bang gach duoi: server.port -> SERVER_PORT. Docker dung duong nay.
 */
public final class Config {

    private final Properties properties = new Properties();

    private Config() {
    }

    public static Config load(Path file) {
        Config config = new Config();
        if (Files.exists(file)) {
            try (InputStream in = Files.newInputStream(file)) {
                config.properties.load(in);
            } catch (IOException failure) {
                throw new IllegalStateException("Khong doc duoc " + file, failure);
            }
        } else {
            System.err.println("Canh bao: khong thay " + file + ", dung gia tri mac dinh");
        }
        return config;
    }

    public String get(String key, String fallback) {
        String fromEnv = System.getenv(key.toUpperCase().replace('.', '_'));
        if (fromEnv != null && !fromEnv.isBlank()) {
            return fromEnv.trim();
        }
        String value = properties.getProperty(key);
        if (value == null) {
            return fallback;
        }
        int comment = value.indexOf('#');
        if (comment >= 0) {
            value = value.substring(0, comment);
        }
        value = value.trim();
        return value.isEmpty() ? fallback : value;
    }

    public int getInt(String key, int fallback) {
        try {
            return Integer.parseInt(get(key, String.valueOf(fallback)));
        } catch (NumberFormatException failure) {
            return fallback;
        }
    }

    public boolean getBoolean(String key, boolean fallback) {
        return Boolean.parseBoolean(get(key, String.valueOf(fallback)));
    }

    /** "127.0.0.1:6001,127.0.0.1:6002" -> danh sach endpoint cua rules service. */
    public List<Endpoint> getEndpoints(String key, String fallback) {
        List<Endpoint> endpoints = new ArrayList<>();
        for (String item : get(key, fallback).split(",")) {
            String trimmed = item.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            int colon = trimmed.lastIndexOf(':');
            if (colon < 0) {
                throw new IllegalArgumentException("Endpoint sai dinh dang: " + trimmed);
            }
            endpoints.add(new Endpoint(trimmed.substring(0, colon),
                    Integer.parseInt(trimmed.substring(colon + 1))));
        }
        return endpoints;
    }

    public record Endpoint(String host, int port) {
        @Override
        public String toString() {
            return host + ":" + port;
        }
    }

    /** In ra cau hinh dang chay - bat buoc khi do thuc nghiem va khi demo. */
    public String describe() {
        return """
                io=%s  format=%s  ioWorkers=%d  gamePool=%d  maxConn=%d
                clock.compensation=%s (cap %d ms)   heartbeat=%d/%d ms   grace=%d ms
                rules.mode=%s  endpoints=%s  pool=%d  timeout=%d ms  cache=%d
                db=%s  user=%s  poolSize=%d
                log.level=%s"""
                .formatted(
                        get("server.io", "nio"), get("server.format", "binary"),
                        getInt("server.ioWorkers", 4), getInt("server.gamePoolSize", 8),
                        getInt("server.maxConnections", 1000),
                        get("clock.compensation", "true"), getInt("clock.compensationCapMs", 200),
                        getInt("heartbeat.intervalMs", 5000), getInt("heartbeat.timeoutMs", 15000),
                        getInt("reconnect.graceMs", 60000),
                        get("rules.mode", "remote"), getEndpoints("rules.endpoints", "127.0.0.1:6001"),
                        getInt("rules.poolPerEndpoint", 4), getInt("rules.timeoutMs", 200),
                        getInt("rules.cacheSize", 50000),
                        get("db.url", ""), get("db.user", ""), getInt("db.poolSize", 8),
                        get("log.level", "INFO"));
    }
}
