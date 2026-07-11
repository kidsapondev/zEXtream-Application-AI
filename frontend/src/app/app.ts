import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastStackComponent } from './design-system/toast-stack/toast-stack.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastStackComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {}
