package main

import "testing"

func TestToolchain(t *testing.T) {
	if 1+1 != 2 {
		t.Fatal("math broken")
	}
}
