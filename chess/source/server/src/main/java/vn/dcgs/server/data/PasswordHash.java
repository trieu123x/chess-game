package vn.dcgs.server.data;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Bam mat khau: sha256(username || ':' || password), hex thuong.
 *
 * Dung dung cong thuc ma schema.sql va bo du lieu mau dung, de ba noi (SQL,
 * server, script sinh tai khoan bot) khong lech nhau.
 *
 * Han che da biet, phai ghi vao muc Limitations cua bao cao: SHA-256 tran
 * khong co salt va qua nhanh, khong phai lua chon dung cho he thong that;
 * viec doi sang bcrypt/argon2 nam o Future Work.
 */
public final class PasswordHash {

    private PasswordHash() {
    }

    public static String of(String username, String password) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest((username + ':' + password).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte value : bytes) {
                hex.append(Character.forDigit((value >> 4) & 0xF, 16));
                hex.append(Character.forDigit(value & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("JVM khong co SHA-256", impossible);
        }
    }

    /** So sanh theo thoi gian hang so - khong de lo do dai phan khop qua thoi gian phan hoi. */
    public static boolean matches(String username, String password, String expectedHash) {
        return MessageDigest.isEqual(
                of(username, password).getBytes(StandardCharsets.UTF_8),
                expectedHash == null ? new byte[0] : expectedHash.getBytes(StandardCharsets.UTF_8));
    }
}
