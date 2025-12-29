// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-database.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyD7_CLEtu0YBSZCJQZTWt_20UT3H5DatJY",
  authDomain: "atlas-gym-system-366b3.firebaseapp.com",
  databaseURL: "https://atlas-gym-system-366b3-default-rtdb.firebaseio.com",
  projectId: "atlas-gym-system-366b3",
  storageBucket: "atlas-gym-system-366b3.firebasestorage.app",
  messagingSenderId: "219431091596",
  appId: "1:219431091596:web:87be3709af10a82da1aaa9"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

export { app, database };
