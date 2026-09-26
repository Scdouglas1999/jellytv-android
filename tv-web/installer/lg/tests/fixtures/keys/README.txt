Test keys made on the development machine for the tests only (never on a TV):
  webos_rsa          ssh-keygen -t rsa -m PEM -N 78DB5E -C developer@device (what the TV's start-devmode.sh makes:
                     traditional PEM, AES-128-CBC, served by the key server at :9991/webos_rsa)
  webos_rsa_openssh  the same in OpenSSH's newer format
  webos_rsa_3des     openssl genrsa -traditional -des3 (another traditional cipher)
Passphrase for all three: 78DB5E.
