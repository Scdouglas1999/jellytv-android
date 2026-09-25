using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Tally.LgInstaller.Webos;

public sealed class DevModeKeyException(string message) : Exception(message);

/// <summary>
/// The TV's Developer Mode SSH key. With Key Server on, the Developer Mode app serves it at
/// <c>http://&lt;tv&gt;:9991/webos_rsa</c> (LG's CLI: @webos-tools/cli lib/base/novacom.js; webosbrew ares-cli-rs
/// setup.rs). The TV makes it with <c>ssh-keygen -t rsa -N &lt;passphrase&gt;</c>, and it arrives as an OpenSSL
/// "traditional" encrypted PEM (<c>BEGIN RSA PRIVATE KEY</c>, <c>Proc-Type: 4,ENCRYPTED</c>,
/// <c>DEK-Info: AES-128-CBC,&lt;iv&gt;</c>); the passphrase is the 6 characters the Developer Mode app shows (the
/// first six of the TV's nduid, upper-case hex: 78DB5E). Unlocked here, so a wrong passphrase is told as such before
/// any SSH, and handed to SSH.NET as a plain PKCS#1 key. A newer OpenSSH-format key (<c>BEGIN OPENSSH PRIVATE KEY</c>)
/// is passed to SSH.NET with the passphrase as it is.
/// </summary>
public static class DevModeKey
{
    public const int KeyServerPort = 9991;

    /// <summary>Fetches the key from the TV's key server. Null when nothing answers (Key Server off).</summary>
    public static async Task<string?> FetchAsync(HttpClient http, string tv, int port, CancellationToken ct)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            using var response = await http.GetAsync($"http://{tv}:{port}/webos_rsa", limit.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            var text = await response.Content.ReadAsStringAsync(limit.Token).ConfigureAwait(false);
            return text.Contains("PRIVATE KEY-----", StringComparison.Ordinal) ? text : null;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            return null;
        }
    }

    /// <summary>What the person types, as the app shows it: spaces dropped, letters upper-cased.</summary>
    public static string NormalizePassphrase(string typed) => Regex.Replace(typed, @"\s+", "").ToUpperInvariant();

    /// <summary>
    /// The key, unlocked: a PKCS#1 PEM for a traditional encrypted key (or an unencrypted one as it is), or the
    /// OpenSSH key unchanged. Throws <see cref="DevModeKeyException"/> for a wrong passphrase.
    /// </summary>
    public static string Unlock(string pem, string passphrase)
    {
        if (pem.Contains("BEGIN OPENSSH PRIVATE KEY", StringComparison.Ordinal))
        {
            return pem;
        }

        if (pem.Contains("BEGIN ENCRYPTED PRIVATE KEY", StringComparison.Ordinal))
        {
            using var rsa = RSA.Create();
            try
            {
                rsa.ImportFromEncryptedPem(pem, passphrase);
            }
            catch (CryptographicException)
            {
                throw new DevModeKeyException("That passphrase does not unlock the TV's key.");
            }

            return rsa.ExportRSAPrivateKeyPem();
        }

        var m = Regex.Match(pem, @"-----BEGIN (?<type>[A-Z ]+) PRIVATE KEY-----\s*(?<headers>(?:[A-Za-z-]+:[^\r\n]*\r?\n)*)\s*(?<body>[A-Za-z0-9+/=\s]+?)-----END");
        if (!m.Success)
        {
            throw new DevModeKeyException("What the TV's key server sent is not a key.");
        }

        var headers = m.Groups["headers"].Value;
        var body = Convert.FromBase64String(Regex.Replace(m.Groups["body"].Value, @"\s+", ""));
        var type = m.Groups["type"].Value;
        if (!headers.Contains("ENCRYPTED", StringComparison.Ordinal))
        {
            return Pem(type, body);
        }

        var dek = Regex.Match(headers, @"DEK-Info:\s*(?<cipher>[A-Z0-9-]+),(?<iv>[0-9A-Fa-f]+)");
        if (!dek.Success)
        {
            throw new DevModeKeyException("The TV's key is locked in a way this program does not know.");
        }

        var iv = Convert.FromHexString(dek.Groups["iv"].Value);
        var plain = Decrypt(dek.Groups["cipher"].Value, Encoding.UTF8.GetBytes(passphrase), iv, body);
        if (plain is null || !IsKey(type, plain))
        {
            throw new DevModeKeyException("That passphrase does not unlock the TV's key.");
        }

        return Pem(type, plain);
    }

    private static string Pem(string type, byte[] der) =>
        $"-----BEGIN {type} PRIVATE KEY-----\n{Convert.ToBase64String(der, Base64FormattingOptions.InsertLineBreaks).Replace("\r\n", "\n", StringComparison.Ordinal)}\n-----END {type} PRIVATE KEY-----\n";

    private static bool IsKey(string type, byte[] der)
    {
        try
        {
            if (type == "RSA")
            {
                using var rsa = RSA.Create();
                rsa.ImportRSAPrivateKey(der, out var read);
                return read == der.Length;
            }

            if (type == "EC")
            {
                using var ec = ECDsa.Create();
                ec.ImportECPrivateKey(der, out var read);
                return read == der.Length;
            }

            return true;
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    /// <summary>OpenSSL's traditional PEM encryption: key = EVP_BytesToKey(MD5, passphrase, salt = the IV's first 8 bytes).</summary>
    public static byte[]? Decrypt(string cipher, byte[] passphrase, byte[] iv, byte[] data)
    {
        var (keyLength, make) = cipher switch
        {
            "AES-128-CBC" => (16, (Func<SymmetricAlgorithm>)Aes.Create),
            "AES-192-CBC" => (24, Aes.Create),
            "AES-256-CBC" => (32, Aes.Create),
            "DES-EDE3-CBC" => (24, TripleDES.Create),
            _ => throw new DevModeKeyException($"The TV's key is locked with {cipher}, which this program does not know."),
        };
        var key = BytesToKey(passphrase, iv.AsSpan(0, 8).ToArray(), keyLength);
        using var alg = make();
        alg.Key = key;
        try
        {
            return alg.DecryptCbc(data, iv, PaddingMode.PKCS7);
        }
        catch (CryptographicException)
        {
            return null; // bad padding: a wrong passphrase
        }
    }

    /// <summary>EVP_BytesToKey with MD5 and one round, as OpenSSL's PEM_read does.</summary>
    public static byte[] BytesToKey(byte[] passphrase, byte[] salt, int length)
    {
        var key = new List<byte>();
        var last = Array.Empty<byte>();
        while (key.Count < length)
        {
            last = MD5.HashData([.. last, .. passphrase, .. salt]);
            key.AddRange(last);
        }

        return key.Take(length).ToArray();
    }
}
