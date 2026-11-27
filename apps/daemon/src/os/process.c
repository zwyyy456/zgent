#include "platform.h"
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "connect") == 0) {
        struct sockaddr_un address = {0};
        if (strlen(argv[2]) >= sizeof(address.sun_path)) return 4;
        address.sun_family = AF_UNIX;
        strcpy(address.sun_path, argv[2]);
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) return 4;
        int rc = connect(fd, (struct sockaddr *)&address, sizeof(address));
        close(fd);
        return rc == 0 ? 0 : 3;
    }
    if (argc == 2 && strcmp(argv[1], "boot") == 0) {
        char boot[64];
        if (boot_identity(boot, sizeof(boot)) != 0) return 4;
        puts(boot);
        return 0;
    }
    if (argc >= 4 && strcmp(argv[1], "lock") == 0) {
        int fd = open(argv[2], O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
        if (fd < 0) return 4;
        if (flock(fd, LOCK_EX | LOCK_NB) != 0) return errno == EWOULDBLOCK ? 73 : 4;
        if (fd != 3) {
            if (dup2(fd, 3) < 0) return 4;
            close(fd);
        }
        execv(argv[3], &argv[3]);
        return 4;
    }
    if (argc >= 3 && strcmp(argv[1], "worker") == 0) {
        char permit;
        if (read(3, &permit, 1) != 1 || permit != '1') return 74;
        close(3);
        execv(argv[2], &argv[2]);
        return 4;
    }
    if (argc < 3) return 2;
    pid_t pid = (pid_t)strtol(argv[2], NULL, 10);
    if (pid < 2) return 2;
    if (strcmp(argv[1], "group") == 0) {
        return kill(-pid, 0) == 0 ? 0 : (errno == ESRCH ? 3 : 4);
    }
    char birth[64];
    pid_t observed_group = 0;
    int status = process_identity(pid, birth, sizeof(birth), &observed_group);
    if (status != 0) return status;
    if (strcmp(argv[1], "identity") == 0) {
        printf("%s %ld\n", birth, (long)observed_group);
        return 0;
    }
    if (argc != 6 || strcmp(argv[1], "signal") != 0) return 2;
    pid_t pgid = (pid_t)strtol(argv[4], NULL, 10);
    if (pid != pgid || pgid != observed_group || strcmp(argv[3], birth) != 0) return 4;
    int signal = strcmp(argv[5], "TERM") == 0 ? SIGTERM : SIGKILL;
    return kill(-pgid, signal) == 0 ? 0 : (errno == ESRCH ? 3 : 4);
}
