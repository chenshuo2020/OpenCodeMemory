package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
)

const (
	createNoWindow                    = 0x08000000
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x00002000
	processSetQuota                   = 0x0100
	processTerminate                  = 0x0001
)

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	createJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	setInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	assignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
)

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInfo struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}

	installRoot := filepath.Clean(filepath.Join(filepath.Dir(executable), ".."))
	nodeExecutable := filepath.Join(installRoot, "runtime", "node.exe")
	launcher := filepath.Join(installRoot, "service-wrapper", "OpenCodeMemoryService.mjs")
	workingDirectory := filepath.Join(installRoot, "service")
	logFile := openLogFile()
	if logFile != nil {
		defer logFile.Close()
	}

	for _, required := range []string{nodeExecutable, launcher, workingDirectory} {
		if _, err := os.Stat(required); err != nil {
			writeLog(logFile, "required path is unavailable: %s (%v)", required, err)
			os.Exit(2)
		}
	}

	job, jobErr := createKillOnCloseJob()
	if jobErr != nil {
		writeLog(logFile, "unable to create service job object: %v", jobErr)
	} else {
		defer syscall.CloseHandle(job)
	}

	command := exec.Command(nodeExecutable, launcher)
	command.Dir = workingDirectory
	command.Env = os.Environ()
	command.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNoWindow,
		HideWindow:    true,
	}
	if logFile != nil {
		command.Stdout = logFile
		command.Stderr = logFile
	}

	writeLog(logFile, "starting hidden Node.js service: %s %s", nodeExecutable, launcher)
	if err := command.Start(); err != nil {
		writeLog(logFile, "unable to start hidden Node.js service: %v", err)
		os.Exit(3)
	}

	if job != 0 {
		if err := addProcessToJob(job, command.Process.Pid); err != nil {
			// Task Scheduler also tracks descendants. Keep the service running if
			// a host-specific job policy prevents the additional safety job.
			writeLog(logFile, "unable to assign Node.js service to safety job: %v", err)
		}
	}

	err = command.Wait()
	if err == nil {
		writeLog(logFile, "Node.js service exited normally")
		return
	}

	if exitError, ok := err.(*exec.ExitError); ok {
		exitCode := exitError.ExitCode()
		writeLog(logFile, "Node.js service exited with code %d", exitCode)
		if exitCode > 0 && exitCode < 256 {
			os.Exit(exitCode)
		}
	}

	writeLog(logFile, "Node.js service stopped: %v", err)
	os.Exit(4)
}

func createKillOnCloseJob() (syscall.Handle, error) {
	handle, _, callErr := createJobObjectW.Call(0, 0)
	if handle == 0 {
		return 0, normalizeCallError(callErr)
	}

	job := syscall.Handle(handle)
	info := jobObjectExtendedLimitInfo{}
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	result, _, callErr := setInformationJobObject.Call(
		handle,
		jobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if result == 0 {
		syscall.CloseHandle(job)
		return 0, normalizeCallError(callErr)
	}
	return job, nil
}

func addProcessToJob(job syscall.Handle, pid int) error {
	process, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(pid))
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(process)

	result, _, callErr := assignProcessToJobObject.Call(uintptr(job), uintptr(process))
	if result == 0 {
		return normalizeCallError(callErr)
	}
	return nil
}

func normalizeCallError(err error) error {
	if err == nil || err == syscall.Errno(0) {
		return syscall.EINVAL
	}
	return err
}

func openLogFile() *os.File {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	directory := filepath.Join(home, ".opencode-mem")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil
	}
	file, err := os.OpenFile(filepath.Join(directory, "service-host.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil
	}
	return file
}

func writeLog(file *os.File, format string, args ...interface{}) {
	if file == nil {
		return
	}
	message := fmt.Sprintf(format, args...)
	fmt.Fprintf(file, "[%s] %s\r\n", time.Now().Format(time.RFC3339Nano), message)
}
