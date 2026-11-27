#include "platform.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int process_identity(pid_t pid, char *birth, size_t size, pid_t *pgid) {
    char path[64], row[8192];
    snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
    FILE *file = fopen(path, "r");
    if (!file) return errno == ENOENT ? 3 : 4;
    int read = fgets(row, sizeof(row), file) != NULL;
    fclose(file);
    if (!read) return 4;
    char *name_end = strrchr(row, ')');
    if (!name_end) return 4;
    char *next = NULL;
    int field = 3;
    for (char *value = strtok_r(name_end + 1, " ", &next); value; value = strtok_r(NULL, " ", &next), field++) {
        if (field == 5) *pgid = (pid_t)strtol(value, NULL, 10);
        if (field == 22) {
            snprintf(birth, size, "%s", value);
            return 0;
        }
    }
    return 4;
}

int boot_identity(char *boot, size_t size) {
    FILE *file = fopen("/proc/sys/kernel/random/boot_id", "r");
    if (!file) return 4;
    int read = fgets(boot, (int)size, file) != NULL;
    fclose(file);
    if (!read) return 4;
    boot[strcspn(boot, "\r\n")] = '\0';
    return 0;
}
