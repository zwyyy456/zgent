#ifndef ZGENT_PLATFORM_H
#define ZGENT_PLATFORM_H
#include <stddef.h>
#include <sys/types.h>
int process_identity(pid_t pid, char *birth, size_t size, pid_t *pgid);
int boot_identity(char *boot, size_t size);
#endif
